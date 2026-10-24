import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {priceOptions} from '../src/price-options.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';
import {planOriginalRestore,fingerprint} from '../src/policy.mjs';
test('an impossible ratio remains a complete pending review with explicit unavailable options and exact alternative consent',()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j),b=structuredClone(f.baseline);b.productId='300009';b.skus[0].baseFen=100;b.skus[1].baseFen=100000000;
  j.remember(b,now);const current={...structuredClone(b),observedAt:now},plan=planOriginalRestore(b,current,f.policy,now);
  const loss=structuredClone(f.loss);loss.removal.productId=b.productId;loss.removalEvidence.record=structuredClone(loss.removal);
  const review=j.recordRemovalPriceReview(plan,loss,now),options=priceOptions(review);
  assert.equal(review.status,'pending');assert.equal(review.rows.length,2);assert.equal(review.originalUnavailable.code,'NO_FEASIBLE_PRICE');
  assert.ok(options.slice(0,3).every(o=>!o.available&&o.reason));assert.equal(options[3].available,true);
  const consent={confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true,historicalFingerprint:fingerprint(b)};
  assert.throws(()=>j.decidePriceReview(b.shopId,review.id,review.key,'approve',consent,now),{code:'PRICE_OPTION_CHANGED'});
  const selected=options[3],approved=j.decidePriceReview(b.shopId,review.id,review.key,'approve',{...consent,optionId:selected.id,optionKey:selected.key},now);
  assert.equal(approved.type,'限时抢购');assert.equal(j.list(b.shopId).length,0,'Consent never constitutes a submission or readback');
 }finally{j.close();}
});
