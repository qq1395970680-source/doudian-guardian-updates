import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';
import {fingerprint} from '../../src/policy.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const mode of ['regular','restarted-target','unknown'])test('12 approved numeric-floor products recover together: '+mode,{timeout:360000},async()=>{
 const products=Array.from({length:12},(_,i)=>({productId:String(3600000000000000000n+BigInt(i)),name:'批量提价商品'+i,
  skus:Array.from({length:2},(_,k)=>({id:String(5600000000000000000n+BigInt(i*10+k)),name:'规格'+k,baseFen:10000+k*100,discount:60}))}));
 const fixture=await fixtureServer({catalogProducts:products,limited:true,detailObservedPrices:true,dropAfterSubmit:mode==='unknown',skuPriceFloors:Object.fromEntries(products.map(p=>[p.skus[0].id,6100]))});
 const original=fixture.state.campaigns[0],at=Math.floor(Date.now()/1000)*1000;
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:at-60000,endAt:at-60000+7*86400000,
  products:products.map(p=>({...p,activityLimit:1000,removalConfirmed:true,removalRiskConfirmed:true}))});
 const dir=await mkdtemp(join(tmpdir(),'guardian-followup-batch-')),file=join(dir,'tasks.sqlite');
 let browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(file);
 new AccountRegistry(journal).register({shopId:'900001'},'signin-followup-fixture');setPriceIncreasePolicy(journal,'900001',{enabled:true,acceptHigherPricesAndRisk:true});
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 const reopen=async()=>{
  journal.release(policy.shopId,service.owner);service.stop();await browser.close();journal.close();
  browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});journal=new Journal(file);
  platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});service=new GuardianService({platform,journal,policy});
 };
 try{
  const discovery=await platform.discover({historyReadLimit:20});assert.equal(discovery.activeComplete,true);
  const baselines=discovery.baselines;assert.equal(baselines.length,12);
  for(const b of baselines)journal.remember(b);journal.lease(policy.shopId,service.owner,Date.now(),300000);
  await service.recoverBatch(baselines.map(baseline=>({baseline})),(member,error)=>{
   journal.putProductCheck(policy.shopId,member.baseline.productId,{code:error.code,lossKey:member.loss?.lossKey,contextKey:fingerprint(member.baseline),at:Date.now(),retryAt:Date.now()+900000});
  });
  assert.equal(fixture.state.submits,0);assert.equal(service.priceIncreaseFollowups.size,12);
  assert.equal(journal.priceReviews(policy.shopId).filter(r=>r.approvalKind==='automatic-price-increase').length,12);
  assert.equal(journal.productChecks(policy.shopId).length,0,'old rejected prices must not cool down the exact replacement approvals');
  const prior=journal.list(policy.shopId);assert.equal(prior.length,1);assert.equal(prior[0].phase,'blocked');
  assert.equal(prior[0].submitAttempts,0);assert.equal(prior[0].riskAttempts,0);
  const originalTargets=baselines.map(b=>journal.priceTarget(policy.shopId,b.productId));
  if(mode==='restarted-target'){
   await reopen();assert.equal(service.priceIncreaseFollowups.size,0);await service.tick();
  }else await service.recoverPriceIncreases();
  let unknownTask=null;
  if(mode==='unknown'){
   const unknown=journal.list(policy.shopId).find(t=>t.phase==='unknown');assert.ok(unknown,JSON.stringify(service.status()));
   assert.equal(unknown.plans.length,12);assert.equal(unknown.submitAttempts,1);assert.equal(unknown.riskAttempts,1);unknownTask=unknown.id;
   assert.equal(fixture.state.submits,1);await reopen();await service.tick();
   assert.equal(journal.get(unknownTask).phase,'verified');assert.equal(journal.get(unknownTask).submitAttempts,1);assert.equal(journal.get(unknownTask).riskAttempts,1);
  }
  const tasks=journal.list(policy.shopId).filter(t=>t.phase==='verified'),verified=tasks.flatMap(t=>t.plans.map(p=>p.productId));
  const report={at:new Date().toISOString(),mode,localFixtureOnly:true,liveShopTouched:false,approvedFromDirectLiveDraft:12,
   verifiedProducts:verified.length,batchSizes:tasks.map(t=>t.plans.length),skuCounts:tasks.map(t=>t.receipt.skuCount),
   remainingFollowups:service.priceIncreaseFollowups.size,submits:fixture.state.submits,risks:fixture.state.risks,
   exactHigherPriceFen:6100,unapprovedDecreases:false,realStoreThroughput:false,unknownTask};
  const reportFile='artifacts/automatic-followup-native-'+mode+'.json';
  await writeFile(resolve(reportFile),JSON.stringify(report,null,2)+'\n');
  assert.deepEqual(verified.sort(),products.map(p=>p.productId).sort(),JSON.stringify(report));assert.equal(tasks.length,1);assert.equal(tasks[0].receipt.skuCount,24);
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);assert.equal(service.priceIncreaseFollowups.size,0);
  assert.ok(fixture.state.seenPrices.every(p=>p.discount>=60));assert.equal(fixture.state.cancelAttempts||0,0);
  assert.ok(originalTargets.every(t=>fingerprint(journal.priceReview(t.id))===fingerprint(t)),'restarts keep the exact immutable approvals');
  await service.tick();assert.equal(fixture.state.submits,1,'later patrol cannot recreate the approved activity');
  assert.equal(fixture.state.risks,1);assert.equal(fixture.state.creates,1);
  await writeFile(resolve(reportFile),JSON.stringify({...report,passed:true,laterPatrolNoDuplicate:true},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
