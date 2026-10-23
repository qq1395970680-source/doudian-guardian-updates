import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {fixedNow as now} from './helpers/price-review-fixture.mjs';
import {automaticFollowupFixture} from './helpers/automatic-followup-fixture.mjs';

for(const count of [12,105])test('approved numeric-floor followups process '+count+' products within normal batch budgets without a five-product cap',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,count,now),service=new GuardianService({journal:j,...f,now:()=>now});
  for(const b of f.baselines)service.priceIncreaseFollowups.add(b.productId);j.lease(f.policy.shopId,service.owner,now);
  await service.recoverPriceIncreases();const tasks=j.list(f.policy.shopId).filter(t=>t.phase==='verified');
  const actual=tasks.flatMap(t=>t.plans.map(p=>p.productId)).sort(),expected=f.baselines.map(b=>b.productId).sort();
  const report={at:new Date().toISOString(),localSchedulerFixtureOnly:true,count,verifiedProducts:actual.length,submits:f.counts.submits,
   batchSizes:tasks.map(t=>t.plans.length).sort((a,b)=>b-a),skuCounts:tasks.map(t=>t.receipt.skuCount),remainingFollowups:service.priceIncreaseFollowups.size,
   precheckGroups:f.counts.precheckGroups.map(g=>g.length),lossGroups:f.counts.lossGroups.map(g=>g.length),realStoreThroughput:false};
  await writeFile(resolve('artifacts/automatic-followup-batches-'+count+'.json'),JSON.stringify(report,null,2)+'\n');
  assert.equal(actual.length,expected.length,JSON.stringify(report));assert.deepEqual(actual,expected);
  assert.equal(service.priceIncreaseFollowups.size,0);assert.deepEqual(report.batchSizes,count===12?[12]:[50,50,5]);
  assert.ok(tasks.every(t=>t.plans.length<=50&&t.receipt.skuCount<=500&&t.plans.every(p=>p.skus[0].saleFen===6100)));
  assert.ok(j.priceReviews(f.policy.shopId).every(r=>r.approvalKind==='automatic-price-increase'&&r.status==='approved'));
 }finally{j.close();}
});

test('a new floor discovered in a followup receives an exact new target but cannot recurse within the same pass',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,1,now),prepare=f.platform.prepare;let changed=false;
  f.platform.prepare=async task=>{
   const draft=await prepare(task);
   if(!changed){changed=true;const probe={...draft.observation,warnings:['活动价不得低于62元'],rows:draft.observation.rows.map((r,i)=>({...r,errors:i?[]:['活动价不得低于62元']}))};
    throw Object.assign(new Error('New explicit floor'),{code:'PRICE_REVIEW_REQUIRED',detail:{priceProbe:probe}});
   }return draft;
  };
  const service=new GuardianService({journal:j,...f,now:()=>now}),product=f.baselines[0].productId;
  service.priceIncreaseFollowups.add(product);j.lease(f.policy.shopId,service.owner,now);
  await service.recoverPriceIncreases();assert.equal(f.counts.submits,0);assert.equal(service.priceIncreaseFollowups.size,1);
  assert.equal(j.priceTarget(f.policy.shopId,product).rows[0].saleFen,6200);
  await service.recoverPriceIncreases();assert.equal(f.counts.submits,1);assert.equal(service.priceIncreaseFollowups.size,0);
  const task=j.list(f.policy.shopId).find(t=>t.phase==='verified');assert.equal(task.plans[0].skus[0].saleFen,6200);
  assert.equal(j.histories(f.policy.shopId)[0].skus[0].discount,60);
 }finally{j.close();}
});

test('a rejected old draft cannot cool down its newly approved target after the in-memory followup queue is lost',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,12,now),prepare=f.platform.prepare,originalTargets=f.baselines.map(b=>j.priceTarget(f.policy.shopId,b.productId));let first=true;
  f.platform.prepare=async task=>{
   const draft=await prepare(task);if(!first)return draft;first=false;
   const probe={...draft.observation,warnings:['活动价不得低于62元'],rows:draft.observation.rows.map(r=>({...r,
    errors:task.plans.some(p=>p.skus[0].id===r.id)?['活动价不得低于62元']:[]}))};
   throw Object.assign(new Error('New exact floor'),{code:'PRICE_REVIEW_REQUIRED',detail:{priceProbe:probe}});
  };
  const service=new GuardianService({journal:j,...f,now:()=>now});j.lease(f.policy.shopId,service.owner,now);
  await service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>{
   j.putProductCheck(f.policy.shopId,member.baseline.productId,{code:error.code,contextKey:fingerprint(member.baseline),lossKey:member.loss.lossKey,at:now,retryAt:now+900000});
  });
  assert.equal(f.counts.submits,0);assert.equal(service.priceIncreaseFollowups.size,12);
  assert.ok(f.baselines.every(b=>j.priceTarget(f.policy.shopId,b.productId).rows[0].saleFen===6200));
  assert.equal(j.productChecks(f.policy.shopId).length,0,'old-price failure must not reinstate a cooldown after the replacement was approved');
  const blockedTasks=j.list(f.policy.shopId).filter(t=>t.phase==='blocked');assert.equal(blockedTasks.length,13);
  assert.ok(blockedTasks.every(t=>t.submitAttempts===0&&t.riskAttempts===0&&!t.receipt));
  assert.ok(originalTargets.every(t=>j.priceReview(t.id).rows[0].saleFen===6100),'prior exact approvals stay immutable');
  j.release(f.policy.shopId,service.owner);f.platform.discover=async()=>({baselines:[],activeComplete:true});
  const restarted=new GuardianService({journal:j,...f,now:()=>now});assert.equal(restarted.priceIncreaseFollowups.size,0);
  await restarted.tick();assert.equal(f.counts.submits,1);assert.equal(restarted.lastRun.ok,true);
  const verified=j.list(f.policy.shopId).filter(t=>t.phase==='verified');assert.equal(verified.length,1);
  assert.equal(verified[0].plans.length,12);assert.ok(verified[0].plans.every(p=>p.skus[0].saleFen===6200));
  assert.equal(j.events(100).filter(e=>e.kind==='product-target-recheck-pending').length,12);
 }finally{j.close();}
});

test('a platform failure for the same approved target keeps its real block and cooldown',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,1,now),service=new GuardianService({journal:j,...f,now:()=>now});
  f.platform.prepare=async()=>{throw Object.assign(new Error('New platform limit without numeric proof'),{code:'DRAFT_PRICE'});};
  j.lease(f.policy.shopId,service.owner,now);
  await service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>{
   j.putProductCheck(f.policy.shopId,member.baseline.productId,{code:error.code,at:now,retryAt:now+900000});
  });
  assert.equal(f.counts.submits,0);assert.equal(j.productChecks(f.policy.shopId).length,1);
  assert.equal(j.events(100).filter(e=>e.kind==='product-target-recheck-pending').length,0);
 }finally{j.close();}
});

test('a stop after the first approved batch leaves the unstarted backlog for a later fresh pass',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,105,now),service=new GuardianService({journal:j,...f,now:()=>now}),submit=f.platform.submit;
  for(const b of f.baselines)service.priceIncreaseFollowups.add(b.productId);j.lease(f.policy.shopId,service.owner,now);
  f.platform.submit=async(...args)=>{await submit(...args);if(f.counts.submits===1)service.stop();};
  await service.recoverPriceIncreases();assert.equal(f.counts.submits,1);assert.equal(service.priceIncreaseFollowups.size,55);
  assert.equal(j.list(f.policy.shopId).filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0),50);
  service.stopRequested=false;await service.recoverPriceIncreases();assert.equal(f.counts.submits,3);assert.equal(service.priceIncreaseFollowups.size,0);
  assert.equal(j.list(f.policy.shopId).filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0),105);
 }finally{j.close();}
});

test('batch followups exclude an explicit exception and never resubmit a product with an unknown main attempt',async()=>{
 const j=new Journal(':memory:');try{
  const f=automaticFollowupFixture(j,12,now);f.policy.excludedProductIds=[f.baselines[0].productId];
  const service=new GuardianService({journal:j,...f,now:()=>now}),b=f.baselines[1],plan=service.restorePlan(b,{...b,observedAt:now});
  const task=j.enqueue(f.policy.shopId,[plan],{complete:true,observedAt:now,lossKey:'unknown-batch-test'},now),draft=await f.platform.prepare(task);
  j.transition(task.id,'queued','prepared',{},now);j.beginSubmit(task.id,proveDraft(task,draft.observation,now),now);
  j.transition(task.id,'submitting','unknown',{reason:'transport interrupted'},now);
  for(const baseline of f.baselines)service.priceIncreaseFollowups.add(baseline.productId);j.lease(f.policy.shopId,service.owner,now);
  await service.recoverPriceIncreases();const verified=j.list(f.policy.shopId).filter(t=>t.phase==='verified');
  assert.equal(verified.length,1);assert.equal(verified[0].plans.length,10);assert.equal(f.counts.submits,1);
  assert.equal(j.get(task.id).phase,'unknown');assert.equal(j.get(task.id).submitAttempts,1);assert.equal(j.get(task.id).riskAttempts,0);
  assert.ok(verified[0].plans.every(p=>![f.baselines[0].productId,b.productId].includes(p.productId)));
 }finally{j.close();}
});
