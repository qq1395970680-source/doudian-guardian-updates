import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fingerprint,proveDraft} from '../../src/policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const phase of ['queued','prepared'])test('restart of a zero-submit '+phase+' task obtains fresh evidence and resumes the same task',{timeout:180000},async()=>{
 const products=structuredClone(fixtureProducts.slice(0,1)),fixture=await fixtureServer({catalogProducts:products,detailObservedPrices:true});
 const dir=await mkdtemp(join(tmpdir(),'guardian-restart-unsubmitted-')),file=join(dir,'tasks.sqlite');
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(file),platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});
 let service=new GuardianService({platform,journal,policy});
 try{
  const discovery=await platform.discover({historyReadLimit:20});assert.equal(discovery.activeComplete,true);assert.equal(discovery.baselines.length,1);
  const baseline=discovery.baselines[0];journal.remember(baseline);
  const current=await platform.precheck(baseline),plan=service.restorePlan(baseline,current),loss=await platform.loss(baseline,{fresh:true});
  assert.equal(loss.active,false);assert.equal(loss.complete,true);
  const lossEvidence={complete:true,observedAt:loss.observedAt,lossKey:fingerprint([loss.lossKey]),
   ...(loss.removalEvidence?{priceRules:[structuredClone(loss)]}:{})};
  const original=journal.enqueue(policy.shopId,[plan],lossEvidence);
  if(phase==='prepared'){
   journal.lease(policy.shopId,service.owner,Date.now(),300000);
   const draft=await platform.prepare(original);proveDraft(original,draft.observation);
   journal.transition(original.id,'queued','prepared',{preparedAt:Date.now()});
   journal.release(policy.shopId,service.owner);
  }
  assert.equal(fixture.state.submits,0);const beforeRestartPrechecks=fixture.state.prechecks,previousPlans=structuredClone(original.plans);
  // Only this test's dedicated browser and SQLite are reopened. No production
  // service, shop, activity, clock or task execution method is replaced.
  service.stop();await browser.close();journal.close();
  browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});journal=new Journal(file);
  platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});service=new GuardianService({platform,journal,policy});
  await service.tick();
  const tasks=journal.list(policy.shopId),task=journal.get(original.id);
  const proof={at:new Date().toISOString(),localFixtureOnly:true,phaseBeforeRestart:phase,taskId:original.id,
   phaseAfterRestart:task.phase,reason:task.reason||null,retryAfter:task.retryAfter??null,submitAttempts:task.submitAttempts,riskAttempts:task.riskAttempts,
   submits:fixture.state.submits,prechecksBeforeRestart:beforeRestartPrechecks,prechecksAfterRestart:fixture.state.prechecks,
   tasks:tasks.map(t=>({id:t.id,phase:t.phase,products:t.plans.length,reason:t.reason||null})),lastRun:service.lastRun};
  await writeFile(resolve('artifacts/restart-unsubmitted-'+phase+'.json'),JSON.stringify(proof,null,2)+'\n');
  assert.equal(task.phase,'verified',JSON.stringify(proof));assert.equal(tasks.length,1,'the old zero-submit task must not be abandoned or duplicated');
  assert.equal(task.submitAttempts,1);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);
  assert.ok(fixture.state.prechecks>beforeRestartPrechecks,'restart must obtain a new complete SKU read');
  assert.ok(task.plans[0].observedAt>=previousPlans[0].observedAt);assert.equal(task.receipt.skuCount,10);
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(journal.list(policy.shopId).length,1);
  assert.equal(fixture.state.cancelAttempts||0,0);
  await writeFile(resolve('artifacts/restart-unsubmitted-'+phase+'.json'),JSON.stringify({...proof,passed:true,independentReadback:true,
   laterPatrolNoDuplicate:true,noValidActivityCancelled:true,source:'native-browser-fixture'},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

for(const change of ['changed-current-price','new-active-activity'])test('restarted zero-submit work respects fresh '+change,{timeout:180000},async()=>{
 const products=structuredClone(fixtureProducts.slice(0,1)),fixture=await fixtureServer({catalogProducts:products,detailObservedPrices:true});
 const dir=await mkdtemp(join(tmpdir(),'guardian-restart-guard-')),file=join(dir,'tasks.sqlite');
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(file),platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});
 let service=new GuardianService({platform,journal,policy});
 try{
  const baseline=(await platform.discover({historyReadLimit:20})).baselines[0];journal.remember(baseline);
  const current=await platform.precheck(baseline),plan=service.restorePlan(baseline,current),loss=await platform.loss(baseline,{fresh:true});
  const original=journal.enqueue(policy.shopId,[plan],{complete:true,observedAt:loss.observedAt,lossKey:fingerprint([loss.lossKey])});
  const oldPlans=fingerprint(original.plans),prechecks=fixture.state.prechecks;
  service.stop();await browser.close();journal.close();
  if(change==='changed-current-price')products[0].skus[0].baseFen+=100;
  else fixture.state.campaigns.push({...structuredClone(fixture.state.campaigns[0]),id:'4000000000000000099',name:'后来已有的有效活动',status:'进行中',startAt:Date.now()-10000,endAt:Date.now()+86400000});
  browser=new DedicatedBrowser(dir,{test:true});journal=new Journal(file);platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});service=new GuardianService({platform,journal,policy});
  await service.tick();const task=journal.get(original.id),checks=journal.productChecks(policy.shopId);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);assert.equal(fixture.state.risks,0);
  assert.equal(task.phase,'blocked');assert.equal(task.submitAttempts,0);assert.equal(task.riskAttempts,0);assert.equal(fingerprint(task.plans),oldPlans);
  assert.equal(journal.list(policy.shopId).length,1);assert.equal(fixture.state.cancelAttempts||0,0);
  if(change==='changed-current-price'){
   assert.ok(fixture.state.prechecks>prechecks);assert.equal(checks.length,1);assert.equal(checks[0].code,'BASE_PRICE_CHANGED');
  }else assert.equal(checks.length,0);
  await writeFile(resolve('artifacts/restart-unsubmitted-'+change+'.json'),JSON.stringify({at:new Date().toISOString(),change,passed:true,localFixtureOnly:true,
   originalTaskRetained:true,oldPlansPreserved:true,submits:0,creates:0,risks:0,productChecks:checks,liveShopTouched:false},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
