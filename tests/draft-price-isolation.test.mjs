import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint} from '../src/policy.mjs';
import {makePriceReviews} from '../src/price-review.mjs';
import {isolateDraftPriceFailure} from '../src/draft-price-isolation.mjs';
import {GuardianService} from '../src/service.mjs';
import {fixedNow as now,priceFixture} from './helpers/price-review-fixture.mjs';

function fixture(){
  const journal=new Journal(':memory:'),f=priceFixture(journal);
  journal.transition(f.task.id,'queued','blocked',{},now);
  const clean=structuredClone(f.plan);clean.productId='3000000000000000002';
  clean.skus.forEach((s,i)=>s.id=String(5000000000000000010n+BigInt(i)));
  const task=journal.enqueue(f.plan.shopId,[f.plan,clean],{complete:true,lossKey:'two-products',observedAt:now},now);
  const probe={...f.probe,title:task.title,rows:[...f.probe.rows,...clean.skus.map(s=>({...s,productId:clean.productId,errors:[]}))]};
  const recordedReviews=makePriceReviews(task,probe,now).map(p=>journal.recordPriceReview(p,now));
  const failure={code:'PRICE_REVIEW_REQUIRED',taskId:task.id,shopId:task.shopId,plansFingerprint:fingerprint(task.plans),
    validatedAt:now,probe,recordedReviews:recordedReviews.map(({id,key,shopId,productId})=>({id,key,shopId,productId}))};
  const blocked=journal.transition(task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED'},now);
  journal.close();return {task:blocked,failure,badId:f.plan.productId,cleanId:clean.productId};
}

test('a fully proved zero-submit price rejection selects every clean product without changing any plan or approval',()=>{
  const {task,failure,badId,cleanId}=fixture(),before=fingerprint({task,failure});
  const group=isolateDraftPriceFailure(task,failure,now+5000);
  assert.deepEqual(group.cleanProductIds,[cleanId]);assert.deepEqual(group.rejectedProductIds,[badId]);
  assert.deepEqual(group.reviewIds,failure.recordedReviews.map(r=>r.id));
  assert.equal(before,fingerprint({task,failure}));
});

for(const mutation of ['unknown','submitting','verifying','prepared','verified','submit-attempt','risk-attempt','missing-risk-count',
  'stale-validation','future-validation','missing-validation','changed-task','wrong-shop','changed-plan','diagnostic',
  'stale-probe','wrong-probe-shop','wrong-title','incomplete','missing-sku','duplicate-sku','wrong-price','wrong-base',
  'wrong-type','wrong-duration','dialog','unknown-global-warning','unparsed-sku-error','missing-review','review-key','review-shop','review-product','duplicate-review'])
test('price isolation refuses insufficient evidence: '+mutation,()=>{
  const {task,failure}=fixture();
  if(['unknown','submitting','verifying','prepared','verified'].includes(mutation))task.phase=mutation;
  if(mutation==='submit-attempt')task.submitAttempts=1;
  if(mutation==='risk-attempt')task.riskAttempts=1;
  if(mutation==='missing-risk-count')delete task.riskAttempts;
  if(mutation==='stale-validation')failure.validatedAt=now-30001;
  if(mutation==='future-validation')failure.validatedAt=now+1;
  if(mutation==='missing-validation')delete failure.validatedAt;
  if(mutation==='changed-task')failure.taskId='another-task';
  if(mutation==='wrong-shop')failure.shopId='900002';
  if(mutation==='changed-plan')task.plans[1].skus[0].baseFen++;
  if(mutation==='diagnostic')failure.probe.source='local-diagnostic-export';
  if(mutation==='stale-probe')failure.probe.observedAt=now-30001;
  if(mutation==='wrong-probe-shop')failure.probe.shopId='900002';
  if(mutation==='wrong-title')failure.probe.title='another-task';
  if(mutation==='incomplete')failure.probe.complete=false;
  if(mutation==='missing-sku')failure.probe.rows.pop();
  if(mutation==='duplicate-sku')failure.probe.rows.push({...failure.probe.rows[0]});
  if(mutation==='wrong-price')failure.probe.rows.at(-1).saleFen++;
  if(mutation==='wrong-base')failure.probe.rows.at(-1).baseFen++;
  if(mutation==='wrong-type')failure.probe.type='限量抢购';
  if(mutation==='wrong-duration')failure.probe.endAt+=1000;
  if(mutation==='dialog')failure.probe.dialogs=['请确认低价风险'];
  if(mutation==='unknown-global-warning')failure.probe.warnings.push('暂不能创建活动');
  if(mutation==='unparsed-sku-error'){failure.probe.rows.at(-1).errors=['请核对价格'];failure.probe.warnings.push('请核对价格');}
  if(mutation==='missing-review')failure.recordedReviews=[];
  if(mutation==='review-key')failure.recordedReviews[0].key='changed';
  if(mutation==='review-shop')failure.recordedReviews[0].shopId='900002';
  if(mutation==='review-product')failure.recordedReviews[0].productId='3000000000000000099';
  if(mutation==='duplicate-review')failure.recordedReviews.push({...failure.recordedReviews[0]});
  assert.throws(()=>isolateDraftPriceFailure(task,failure,now));
});

test('an entirely price-rejected group remains blocked without an empty or repeated child',()=>{
  const {task,failure}=fixture();
  task.plans=task.plans.slice(0,1);failure.probe.rows=failure.probe.rows.slice(0,2);
  failure.plansFingerprint=fingerprint(task.plans);
  assert.equal(isolateDraftPriceFailure(task,failure,now),null);
});

for(const change of ['active','base-price','stale-loss'])test('clean children still require new independent evidence: '+change,async()=>{
 const journal=new Journal(':memory:');
 try{
  const f=priceFixture(journal);journal.transition(f.task.id,'queued','blocked',{},now);
  const clean=structuredClone(f.baseline);clean.productId='3000000000000000002';
  clean.skus.forEach((s,i)=>s.id=String(5000000000000000010n+BigInt(i)));journal.remember(clean,now);
  let reads=0,lossReads=0,prepares=0,submits=0;
  const current=b=>({shopId:b.shopId,productId:b.productId,observedAt:now,complete:true,
    skus:b.skus.map((s,i)=>({...s,baseFen:s.baseFen+(reads>1&&change==='base-price'&&i===0?1:0)}))});
  const platform={
   precheckBatch:async bs=>{reads++;return bs.map(current);},precheck:async b=>{reads++;return current(b);},
   lossBatch:async bs=>{lossReads++;return bs.map(b=>({productId:b.productId,loss:{complete:true,
    active:lossReads>1&&change==='active',observedAt:lossReads>1&&change==='stale-loss'?now-120001:now,lossKey:'loss:'+b.productId}}));},
   prepare:async task=>{prepares++;const probe={...f.probe,title:task.title,rows:task.plans.flatMap(p=>p.skus.map((s,i)=>({...s,productId:p.productId,
     errors:p.productId===f.baseline.productId&&i===0?[...f.probe.warnings]:[]})))};
    throw Object.assign(new Error('new numeric price cap'),{code:'PRICE_REVIEW_REQUIRED',detail:{priceProbe:probe}});},
   submit:async()=>{submits++;assert.fail('old clean-child evidence must not authorize a submission');}
  };
  const service=new GuardianService({journal,platform,policy:f.policy,now:()=>now}),failures=[];
  const result=await service.recoverBatch([f.baseline,clean].map(baseline=>({baseline})),(m,e)=>failures.push({id:m.baseline.productId,code:e.code}));
  assert.equal(reads,2);assert.equal(prepares,1);assert.equal(submits,0);
  assert.ok(journal.list(f.plan.shopId).every(t=>t.submitAttempts===0));
  assert.equal(journal.priceTarget(f.plan.shopId,f.plan.productId),null);
  if(change==='active'){assert.equal(lossReads,2);assert.equal(result.differentActivity,true);assert.equal(failures.length,1);}
  else assert.ok(failures.some(f=>f.id===clean.productId));
 }finally{journal.close();}
});
