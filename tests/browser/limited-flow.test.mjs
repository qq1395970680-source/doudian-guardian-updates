import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
import {scrollForm} from '../../src/platform-snapshot.mjs';

for(const viewport of [{width:1440,height:960},{width:960,height:600}])
test(`limited: virtual products, quotas, mixed discounts, renewal and independent readback ${viewport.width}`,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-limited-')),fixture=await fixtureServer({limited:true}),browser=new DedicatedBrowser(dir,{test:true,viewport});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{
  const plans=fixtureProducts.slice(0,3).map((p,i)=>{
   const b={...structuredClone(p),shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',
    campaignId:'4000000000000000001',rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},durationMs:7*86400000,activityLimit:1000-i};
   b.skus.forEach((s,j)=>s.discount=j%2?65:50);journal.remember(b);
   return planOriginalRestore(b,{...b,observedAt:Date.now()},policy);
  });
  const task=journal.enqueue(policy.shopId,plans,{complete:true,observedAt:Date.now(),lossKey:'local-fixture-removal'});
  journal.lease(policy.shopId,service.owner,Date.now(),180000);
  await service.execute(task);
  const actual=journal.get(task.id);assert.equal(actual.phase,'verified',JSON.stringify({actual,events:journal.events(5)}));
  assert.equal(actual.receipt.skuCount,30);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);
  assert.deepEqual(actual.receipt.productLimits.map(p=>p.activityLimit),[1000,999,998]);
  assert.equal(actual.receipt.autoRenew,true);assert.equal(actual.receipt.durationMs,7*86400000);
  assert.deepEqual(fixture.state.campaigns.at(-1).products[0].skus.map(s=>s.discount),[50,65,50,65,50,65,50,65,50,65]);
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

for(const mode of ['quota-changed','restart-unknown'])
test(`limited safety: ${mode}`,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-limited-safety-')),fixture=await fixtureServer({limited:true,hideDetailRenewal:true,dropAfterSubmit:mode==='restart-unknown'});
 let browser=new DedicatedBrowser(dir,{test:true});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  const baseline={...structuredClone(fixtureProducts[0]),shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',
   campaignId:'4000000000000000001',rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},durationMs:7*86400000,activityLimit:1000};
  journal.remember(baseline);
  const plan=planOriginalRestore(baseline,{...baseline,observedAt:Date.now()},policy);
  let task=journal.enqueue(policy.shopId,[plan],{complete:true,observedAt:Date.now(),lossKey:'local-fixture-safety'});
  journal.lease(policy.shopId,service.owner,Date.now(),180000);
  if(mode==='quota-changed'){
   const draft=await platform.prepare(task);journal.transition(task.id,'queued','prepared');
   await draft.page.evaluate(scrollForm,0);
   const quantity=draft.page.locator('tr[class*="index-productRow--"] td').nth(4).locator('input');
   await quantity.fill('999');await quantity.press('Tab');
   await assert.rejects(()=>platform.submit(task,draft,()=>assert.fail('no risk confirm'),()=>assert.fail('no submit boundary')),{code:'LIMITED_READBACK'});
   assert.equal(journal.get(task.id).submitAttempts,0);assert.equal(fixture.state.creates,0);
  }else{
   await service.execute(task);task=journal.get(task.id);assert.equal(task.phase,'unknown',task.reason);assert.equal(fixture.state.submits,1);
   await browser.close();journal.release(policy.shopId,service.owner);journal.recoverInterrupted(policy.shopId);
   browser=new DedicatedBrowser(dir,{test:true});platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});
   service=new GuardianService({journal,platform,policy});journal.lease(policy.shopId,service.owner,Date.now(),180000);
   assert.equal(await service.reconcile(journal.get(task.id)),true);
   assert.equal(journal.get(task.id).phase,'verified');assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);
  }
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
