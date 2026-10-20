import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {applyPriceTarget,makePriceReviews} from '../src/price-review.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';

test('a draft numeric cap is solved jointly with its fresh removal ratio, not as a contradictory second proposal',()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j),first=j.recordRemovalPriceReview(f.plan,f.loss,now);
  j.decidePriceReview(first.shopId,first.id,first.key,'approve',{
   confirmedSkuIds:first.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:first.historicalFingerprint
  },now);
  const plan=applyPriceTarget(f.plan,j.priceTarget(first.shopId,first.productId));
  const task=j.enqueue(plan.shopId,[plan],{complete:true,observedAt:now,lossKey:'after-consent',
   priceRules:[structuredClone(f.loss)]},now);
  const message='活动价不得高于70元';
  const probe={source:'live-platform-draft',kind:'draft',shopId:plan.shopId,title:task.title,
   complete:true,observedAt:now,type:plan.type,rules:plan.rules,startAt:now,endAt:now+plan.durationMs,
   dialogs:[],warnings:[message],productLimits:[{productId:plan.productId,activityLimit:1000}],
   rows:plan.skus.map((s,i)=>({...s,productId:plan.productId,errors:i===0?[message]:[]}))};
  const review=makePriceReviews(task,probe,now)[0];
  assert.deepEqual(review.rows.map(s=>s.discount),[70,49],
   'Lowering only the capped SKU would immediately violate the already-known 3.5 ratio');
  assert.equal(review.kind,'sku-price-ratio');assert.equal(review.previousApprovalId,first.id);
  assert.equal(review.ratio.lowerSkuCount,2);
  assert.equal(j.priceTarget(first.shopId,first.productId).id,first.id);
  assert.equal(j.get(task.id).submitAttempts,0);
 }finally{j.close();}
});
