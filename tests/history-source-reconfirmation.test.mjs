import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {ratioFixture,ratioNow} from './helpers/ratio-review-fixture.mjs';
import {priceOptions} from '../src/price-options.mjs';
import {fingerprint} from '../src/policy.mjs';

test('changed historical source produces a new exact-price confirmation instead of a silent campaign block',()=>{
 const j=new Journal(':memory:');try{
  const f=ratioFixture(j),review=j.recordRemovalPriceReview(f.plan,f.loss,ratioNow);
  const option=priceOptions(review).find(o=>o.id==='switch-original');
  const old=j.decidePriceReview(f.policy.shopId,review.id,review.key,'approve',{confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true,
   historicalFingerprint:fingerprint(f.baseline),optionId:option.id,optionKey:option.key},ratioNow+1);
  const baseline={...structuredClone(f.baseline),campaignId:'400002',historyAt:ratioNow+2,skus:f.baseline.skus.map(s=>({...s,discount:40}))};
  j.remember(baseline,ratioNow+2);
  const service=new GuardianService({journal:j,platform:{},policy:f.policy,now:()=>ratioNow+10});
  const current={...structuredClone(baseline),observedAt:ratioNow+10};
  assert.throws(()=>service.restorePlan(baseline,current),{code:'PRICE_RECONFIRM_REQUIRED'});
  const proposal=j.priceReviews(f.policy.shopId).find(r=>r.status==='pending');
  assert.equal(proposal.kind,'history-reconfirmation');assert.equal(proposal.previousApprovalId,old.id);
  assert.equal(j.priceTarget(f.policy.shopId,baseline.productId).id,old.id);assert.equal(j.list(f.policy.shopId).length,0);
  assert.equal(j.priceReview(old.id).status,'approved');assert.equal(proposal.historicalFingerprint,fingerprint(baseline));
  assert.throws(()=>j.decidePriceReview(f.policy.shopId,proposal.id,proposal.key,'approve',{historicalFingerprint:fingerprint(baseline)},ratioNow+11),{code:'PRICE_CONSENT_REQUIRED'});
  const chosen=priceOptions(proposal)[0];
  j.decidePriceReview(f.policy.shopId,proposal.id,proposal.key,'approve',{historicalFingerprint:fingerprint(baseline),confirmedSkuIds:proposal.rows.map(r=>r.id),acceptPriceAndRisk:true,
   optionId:chosen.id,optionKey:chosen.key},ratioNow+12);
  const plan=service.restorePlan(baseline,current);assert.equal(plan.type,'限时抢购');assert.ok(plan.skus.every(s=>s.discount===50));
  j.assertPricePlans(f.policy.shopId,[plan]);
 }finally{j.close();}
});
