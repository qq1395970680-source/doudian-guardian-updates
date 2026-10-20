import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('105 limited products traverse real browser discovery, 50/50/5 batches, readback and next patrol without duplicate submission',{timeout:900000},async()=>{
 const products=Array.from({length:105},(_,i)=>({
  productId:String(3200000000000000000n+BigInt(i)),name:'连续批次商品'+i,
  skus:Array.from({length:10},(_,j)=>({id:String(5200000000000000000n+BigInt(i*10+j)),
   name:'规格'+j,baseFen:10000+i*10+j,discount:60}))
 }));
 const fixture=await fixtureServer({catalogProducts:products,limited:true,detailExpandable:true});
 const original=fixture.state.campaigns[0],started=Date.now();
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,
  startAt:Math.floor(started/1000)*1000-86400000,
  endAt:Math.floor(started/1000)*1000+6*86400000,
  products:[],removals:products.map(p=>({...p,
   reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}))});
 const dir=await mkdtemp(join(tmpdir(),'guardian-continuous-batches-'));
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});
 const service=new GuardianService({platform,policy,journal});
 const artifact=resolve('artifacts/continuous-limited-batches.json');
 let timer;
 try{
  for(const p of products)journal.remember({...p,shopId:policy.shopId,
   source:'verified-platform-history',complete:true,type:'限量抢购',
   historyAt:original.startAt,observedAt:started,campaignId:original.id,
   rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
   durationMs:7*86400000,activityLimit:1000});
  timer=setInterval(()=>console.log(JSON.stringify({localFixtureOnly:true,
   stage:platform.progress?.stage,submits:fixture.state.submits,
   tasks:journal.list(policy.shopId).map(t=>({phase:t.phase,products:t.plans.length})),
   checks:journal.productChecks(policy.shopId).slice(0,2).map(c=>({code:c.code,message:c.message})),
   elapsedMs:Date.now()-started})),30000);
  // Use production scheduler/prepare/submit/readback implementations throughout.
  // No replaced execute(), loss(), precheck() or clock, and no live shop.
  // An actual submission changes the activity listing: the priority boundary
  // deliberately yields for a fresh scan, then the scheduler resumes itself.
  service.start();
  const deadline=Date.now()+12*60000;
  while(journal.list(policy.shopId).filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0)<products.length){
   const blocked=journal.list(policy.shopId).filter(t=>['blocked','unknown'].includes(t.phase));
   assert.equal(blocked.length,0,JSON.stringify(blocked.map(t=>({phase:t.phase,reason:t.reason}))));
   assert.ok(Date.now()<deadline,'automatic continuation did not drain all native browser batches');
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  const restoreDrainMs=Date.now()-started;
  const tasks=journal.list(policy.shopId).sort((a,b)=>a.createdAt-b.createdAt);
  assert.equal(tasks.length,3,JSON.stringify(tasks.map(t=>({phase:t.phase,reason:t.reason,products:t.plans.length}))));
  assert.ok(tasks.every(t=>t.phase==='verified'),JSON.stringify(tasks.map(t=>({phase:t.phase,reason:t.reason}))));
  assert.deepEqual(tasks.map(t=>t.plans.length),[50,50,5]);
  assert.deepEqual(tasks.map(t=>t.receipt.skuCount),[500,500,50]);
  const ids=tasks.flatMap(t=>t.plans.map(p=>p.productId));
  assert.equal(new Set(ids).size,105);assert.deepEqual([...ids].sort(),products.map(p=>p.productId).sort());
  assert.equal(fixture.state.uploads,3);assert.equal(fixture.state.creates,3);
  assert.equal(fixture.state.submits,3);assert.equal(fixture.state.risks,3);
  assert.equal(new Set(tasks.map(t=>t.receipt.campaignId)).size,3);
  assert.ok(tasks.every(t=>t.submitAttempts===1&&t.receipt.productLimits.every(p=>p.activityLimit===1000)));
  assert.equal(fixture.state.cancelAttempts||0,0);assert.equal(fixture.state.editWrites||0,0);
  const finalReadbackAt=Math.max(...tasks.map(t=>t.receipt.verifiedAt));
  while(!(service.lastSuccessfulRun?.ok&&service.lastSuccessfulRun.startedAt>finalReadbackAt)){
   assert.ok(Date.now()<deadline,'automatic next full patrol did not complete after the final readback');
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  service.stop();
  while(service.busy)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(fixture.state.submits,3,'subsequent full patrol must not restore already verified products');
  assert.equal(fixture.state.uploads,3);assert.equal(journal.list(policy.shopId).length,3);
  const report={at:new Date().toISOString(),localFixtureOnly:true,liveShopTouched:false,
   productionServiceAndPlatform:true,products:105,skus:1050,batchSizes:[50,50,5],
   independentReadbacks:3,nextPatrolNoDuplicates:true,submits:3,uploads:3,
   restoreDrainMs,totalMs:Date.now()-started,viewport:{width:960,height:600},
   realHundredsProductStoreValidated:false,scope:'Local native-browser continuous batches, not production throughput or SLA.'};
  await writeFile(artifact,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }catch(error){
  await writeFile(artifact,JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,
   passed:false,error:error.message,lastRun:service.lastRun,progress:platform.progress,
   tasks:journal.list(policy.shopId).map(t=>({id:t.id,phase:t.phase,reason:t.reason,products:t.plans.length})),
   checks:journal.productChecks(policy.shopId),events:journal.events(15),
   submits:fixture.state.submits,uploads:fixture.state.uploads},null,2)+'\n');
  throw error;
 }finally{
  service.stop();while(service.busy)await new Promise(resolve=>setTimeout(resolve,100));
  clearInterval(timer);await browser.close();journal.close();await fixture.close();
  assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());
  assert.ok(basename(dir).startsWith('guardian-continuous-batches-'));
  await rm(dir,{recursive:true,force:true});
 }
});
