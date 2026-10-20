import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {fingerprint,planOriginalRestore} from '../src/policy.mjs';
import {makePriceReviews,applyPriceTarget} from '../src/price-review.mjs';
import {fixedNow as now,priceFixture} from './helpers/price-review-fixture.mjs';

function higherFixture(j,mixed=false){
 const f=priceFixture(j);f.probe.rows[0].errors=['活动价不得低于近15天最低价（70元）'];
 f.probe.rows[1].errors=mixed?['活动价不得高于58元']:[];
 f.probe.warnings=f.probe.rows.flatMap(s=>s.errors);return f;
}
function record(j,f){const r=j.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);j.transition(f.task.id,'queued','blocked',{retryAfter:now+900000},now);return r;}
const consent=r=>({confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint});

for(const mixed of [false,true])test('a higher or mixed proposal is exact and remains non-executable until every SKU is confirmed: '+mixed,()=>{
 const j=new Journal(':memory:');try{
  const f=higherFixture(j,mixed),before=fingerprint(f.baseline),r=record(j,f);
  assert.deepEqual(r.rows.map(s=>[s.previousDiscount,s.discount,s.saleFen]),[[50,51,7089],[60,mixed?58:60,mixed?5800:6000]]);
  assert.equal(r.status,'pending');assert.equal(j.priceTarget(r.shopId,r.productId),null);assert.deepEqual(applyPriceTarget(f.plan,r),f.plan);
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',{...consent(r),confirmedSkuIds:[r.rows[0].id]},now+1),{code:'PRICE_CONSENT_REQUIRED'});
  j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+2);
  const target=j.priceTarget(r.shopId,r.productId),plan=applyPriceTarget(f.plan,target);j.assertPricePlans(r.shopId,[plan]);
  assert.equal(plan.originalRiskAllowed,false);assert.equal(plan.approvedRiskAllowed,true);assert.equal(plan.priceApprovalId,r.id);
  assert.equal(fingerprint(f.baseline),before);assert.equal(j.histories(r.shopId)[0].skus[0].discount,50);
 }finally{j.close();}
});

test('a confirmed higher target and its approval identity survive restart and a missing historical SKU',()=>{
 const dir=mkdtempSync(join(tmpdir(),'guardian-higher-price-')),file=join(dir,'journal.sqlite');let j=new Journal(file);
 try{
  const f=higherFixture(j),r=record(j,f);j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+1);
  j.close();j=new Journal(file);
  const target=j.priceTarget(r.shopId,r.productId),plan=applyPriceTarget(f.plan,target);j.assertPricePlans(r.shopId,[plan]);
  assert.equal(plan.skus[0].discount,51);assert.equal(plan.skus[0].saleFen,7089);
  const current={...f.current,skus:[f.current.skus[1]]};
  const subset=applyPriceTarget(planOriginalRestore(f.baseline,current,f.policy,now),target);
  assert.equal(subset.priceApprovalId,r.id);assert.equal(subset.skus.length,1);assert.equal(subset.skus[0].discount,60);
  assert.equal(j.histories(r.shopId)[0].skus.length,2);j.assertPricePlans(r.shopId,[subset]);
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});

test('lowering an approved higher target, including a return to the old price, requires a new exact approval',()=>{
 const j=new Journal(':memory:');try{
  const f=higherFixture(j),r=record(j,f);j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+1);
  const higher=applyPriceTarget(f.plan,j.priceTarget(r.shopId,r.productId));
  const task=j.enqueue(r.shopId,[higher],{complete:true,lossKey:'new-live-upper-limit',observedAt:now},now+2);
  const probe={...f.probe,title:task.title,warnings:['活动价不得高于70元'],rows:higher.skus.map((s,i)=>({...s,productId:higher.productId,errors:i?[]:['活动价不得高于70元']}))};
  const next=j.recordPriceReview(makePriceReviews(task,probe,now+2)[0],now+2);j.transition(task.id,'queued','blocked',{},now+2);
  assert.equal(next.previousApprovalId,r.id);assert.equal(next.rows[0].previousDiscount,51);assert.equal(next.rows[0].discount,50);
  assert.equal(j.priceTarget(r.shopId,r.productId).id,r.id,'a new cap cannot itself change an approved target');
  j.decidePriceReview(r.shopId,next.id,next.key,'approve',consent(next),now+3);
  assert.throws(()=>j.assertPricePlans(r.shopId,[higher]),{code:'PRICE_APPROVAL_CHANGED'});
  const back=applyPriceTarget(f.plan,j.priceTarget(r.shopId,r.productId));assert.equal(back.skus[0].discount,50);j.assertPricePlans(r.shopId,[back]);
 }finally{j.close();}
});
