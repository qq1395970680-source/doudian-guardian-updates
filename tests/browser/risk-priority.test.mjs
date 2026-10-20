import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {PriorityWatch} from '../../src/priority-watch.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('headless removal inside an ongoing old activity is restored before the unrelated scan finishes',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-risk-priority-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{
  fixture.state.campaigns[0].status='进行中';
  const discovery=await platform.discover({historyReadLimit:0});for(const baseline of discovery.baselines)journal.remember(baseline);
  const original=platform.inventory.listing.campaigns[0],watch=new PriorityWatch(journal,policy.shopId);watch.observe(original,platform.inventory.details.get(original.id));
  // Only the local test platform changes. Real shop campaigns stay untouched.
  fixture.state.campaigns[0].risk=true;
  fixture.state.campaigns[0].products.slice(0,5).forEach(p=>{p.removalConfirmed=true;});
  const unrelated=Array.from({length:6},(_,i)=>({...structuredClone(fixture.state.campaigns[0]),id:String(4000000000000000100n+BigInt(i)),name:'其他活动'+i,risk:false,startAt:original.startAt+60000+i*1000,products:structuredClone(fixtureProducts.slice(5))}));
  fixture.state.campaigns.push(...unrelated);
  const readIds=[],read=platform.detail.bind(platform);platform.detail=async c=>{readIds.push(c.id);return read(c);};
  const started=Date.now();await service.tick();
  assert.equal(readIds[0],original.id,'the affected old activity must be read first');
  assert.equal(service.status().verified,5,JSON.stringify({status:service.status(),events:journal.events(10)}));
  assert.equal(service.priorityResume,true);assert.equal(service.lastRun,null);
  const unrelatedBeforeRestore=unrelated.filter(c=>readIds.includes(c.id)).length;
  assert.equal(unrelatedBeforeRestore,0,'new risk work must run before opening unrelated detail pages');
  const task=journal.list(policy.shopId)[0];assert.equal(task.receipt.skuCount,50);assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.campaigns[0].status,'进行中');
  assert.equal(platform.monitorPages.size,0);const recoveryMs=Date.now()-started;
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(service.status().unknown,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/risk-priority-headless.json'),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,nativeHeadless:true,viewport:{width:960,height:600},affectedActivityStillActive:true,products:5,skus:50,unrelatedBeforeRestore,recoveryMs,submits:fixture.state.submits,repeatPatrolNoDuplicate:true},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
