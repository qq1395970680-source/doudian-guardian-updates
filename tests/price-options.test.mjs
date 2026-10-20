import test from 'node:test';
import assert from 'node:assert/strict';
import {priceOptions} from '../src/price-options.mjs';
import {Journal} from '../src/journal.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';
import {GuardianService} from '../src/service.mjs';
import {campaignChoice} from '../src/campaign-choice.mjs';

test('three explicit strategies preserve original proposal and never lower in the two increase strategies',()=>{
 const j=new Journal(':memory:');
 try{const f=ratioFixture(j),r=j.recordRemovalPriceReview(f.plan,f.loss,now),options=priceOptions(r);
  assert.deepEqual(options.map(o=>o.id),['original','raise-low','balanced','switch-original']);
  assert.deepEqual(options[0].rows,r.rows);
  for(const o of options.slice(1,3)){assert.equal(o.available,true);assert.ok(o.rows.every(row=>row.saleFen>=row.previousFen));}
  assert.equal(j.priceTarget(r.shopId,r.productId),null);
 }finally{j.close();}
});
test('switching activity preserves historical prices only after exact option consent and remains subject to the target draft',()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j,{mixed:true}),r=j.recordRemovalPriceReview(f.plan,f.loss,now),option=priceOptions(r).at(-1);
  assert.equal(option.validationStatus,'unverified');assert.equal(option.campaignTarget.type,'限时抢购');
  assert.deepEqual(option.rows.map(row=>row.discount),[50,50]);
  j.decidePriceReview(r.shopId,r.id,r.key,'approve',{confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,
   historicalFingerprint:r.historicalFingerprint,optionId:option.id,optionKey:option.key},now);
  const service=new GuardianService({journal:j,platform:{},policy:f.policy,now:()=>now});
  const plan=service.restorePlan(f.baseline,f.current);
  assert.equal(plan.type,'限时抢购');assert.deepEqual(plan.rules,campaignChoice('限时抢购').rules);
  assert.deepEqual(plan.skus.map(row=>row.discount),[50,50]);j.assertPricePlans(f.policy.shopId,[plan]);
  const changed=structuredClone(plan);changed.type='限量抢购';
  assert.throws(()=>j.assertPricePlans(f.policy.shopId,[changed]),{code:'CAMPAIGN_CHOICE_CHANGED'});
  service.checkPriceRules(plan,{...f.loss,removalEvidence:{...f.loss.removalEvidence,activityType:'限量抢购'}});
  assert.throws(()=>service.checkPriceRules(plan,{...f.loss,removalEvidence:{...f.loss.removalEvidence,activityType:'限时抢购'}}),{code:'SKU_RATIO_REVIEW_REQUIRED'});
  assert.equal(j.list(f.policy.shopId).length,0);
 }finally{j.close();}
});
test('explicit upper cap prevents increase-only suggestions and never raises original list prices',()=>{
 const j=new Journal(':memory:');
 try{const f=ratioFixture(j),r=j.recordRemovalPriceReview(f.plan,f.loss,now);r.rows[0].bounds={maxFen:5000};
  const options=priceOptions(r);
  assert.equal(options[1].available,false);assert.equal(options[2].available,false);
  assert.ok(options[1].reason.length>0);assert.deepEqual(options[1].rows,[]);
 }finally{j.close();}
});
test('upper original price and verified template range can make increase-only impossible',()=>{
 const j=new Journal(':memory:');
 try{const f=ratioFixture(j,{mixed:true}),r=j.recordRemovalPriceReview(f.plan,f.loss,now),options=priceOptions(r);
  assert.equal(options[1].available,false);assert.equal(options[2].available,false);
 }finally{j.close();}
});
test('an exact selected alternative is persisted and stale or missing option keys cannot approve',()=>{
 const j=new Journal(':memory:');
 try{const f=ratioFixture(j),r=j.recordRemovalPriceReview(f.plan,f.loss,now),option=priceOptions(r)[1];
  const args={confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint,optionId:option.id};
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',args,now),{code:'PRICE_OPTION_CHANGED'});
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',{...args,optionKey:'obsolete'},now),{code:'PRICE_OPTION_CHANGED'});
  assert.equal(j.priceTarget(r.shopId,r.productId),null);
  const approved=j.decidePriceReview(r.shopId,r.id,r.key,'approve',{...args,optionKey:option.key},now);
  assert.equal(approved.selectedOption.id,option.id);assert.deepEqual(approved.rows,option.rows);
 }finally{j.close();}
});

test('infeasible increase choice cannot be approved and timed review offers limited original prices',()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j,{mixed:true}),r=j.recordRemovalPriceReview(f.plan,f.loss,now),options=priceOptions(r);
  const option=options.find(o=>o.id==='raise-low');
  assert.equal(option.available,false);
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',{
   confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint,
   optionId:option.id,optionKey:'infeasible'
  },now),{code:'PRICE_OPTION_CHANGED'});
  assert.equal(j.priceTarget(r.shopId,r.productId),null);
  const reverse=priceOptions({...r,type:'限时抢购'}).at(-1);
  assert.deepEqual(reverse.campaignTarget,campaignChoice('限量抢购'));
  assert.deepEqual(reverse.rows.map(row=>row.discount),[50,50]);
  assert.equal(reverse.validationStatus,'unverified');
 }finally{j.close();}
});
