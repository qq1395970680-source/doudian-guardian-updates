import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint,planOriginalRestore} from '../src/policy.mjs';
import {campaignChoice} from '../src/campaign-choice.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';

export function reconfirmFixture(j=new Journal(':memory:'),now=Date.now(),choice=null){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'3849118543765439254',name:'取整重新确认',campaignId:'4000000000000000001',type:'限量抢购',durationMs:2419207000,activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},skus:[{id:'3386359933583653',name:'规格甲',baseFen:6875,discount:95}]};
 const current={shopId:baseline.shopId,productId:baseline.productId,complete:true,observedAt:now,skus:structuredClone(baseline.skus)};
 const policy={shopId:baseline.shopId,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const plan=planOriginalRestore(baseline,current,policy,now);
 const old={id:'old-approved',key:'old-key',status:'approved',shopId:baseline.shopId,productId:baseline.productId,name:baseline.name,historicalFingerprint:fingerprint(baseline),type:choice?.type||baseline.type,rules:choice?.rules||baseline.rules,
  consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true},createdAt:now-60000,approvedAt:now-50000,expiresAt:now-1000,
  ...(choice?{campaignTarget:choice}:{}),rows:[{id:baseline.skus[0].id,name:'规格甲',baseFen:6875,historicalDiscount:95,previousDiscount:95,previousFen:6531,discount:95,saleFen:6531,bounds:{},evidence:['旧确认记录']}]};
 j.remember(baseline,now);j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(old.id,old.shopId,old.productId,old.status,JSON.stringify(old),now);
 j.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(old.shopId,old.productId,old.id);
 const service=new GuardianService({journal:j,platform:{},policy,now:()=>now});
 const generate=()=>{assert.throws(()=>service.restorePlan(baseline,current),{code:'PRICE_RECONFIRM_REQUIRED'});return j.priceReviews(old.shopId).find(r=>r.status==='pending');};
 const approve=r=>service.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true});
 return {j,now,baseline,current,policy,plan,old,service,generate,approve};
}

test('stale exact approval creates a separate pending whole-product confirmation; approval unlocks fresh plan',()=>{
 const f=reconfirmFixture();try{
  const r=f.generate();assert.ok(r);assert.equal(r.rows[0].previousFen,6531);assert.equal(r.rows[0].saleFen,6532);assert.equal(r.durationMs,2419207000);
  assert.deepEqual(f.j.priceReview(f.old.id),f.old);assert.equal(f.j.priceTarget(f.old.shopId,f.old.productId).id,f.old.id);
  assert.equal(f.generate().id,r.id,'repeated patrol is idempotent');
  assert.throws(()=>f.service.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',confirmedSkuIds:[],acceptPriceAndRisk:true}),{code:'PRICE_CONSENT_REQUIRED'});
  const options=f.j.priceReviewPage(f.old.shopId).reviews.find(x=>x.id===r.id).options;assert.equal(options.length,1);assert.equal(options[0].available,true);
  f.approve(r);const plan=f.service.restorePlan(f.baseline,f.current);f.j.assertPricePlans(f.old.shopId,[plan]);
  assert.equal(plan.skus[0].saleFen,6532);assert.equal(plan.durationMs,2419207000);assert.equal(plan.priceApprovalId,r.id);
  assert.equal(plan.originalRiskAllowed,false);assert.equal(plan.approvedRiskAllowed,true);assert.deepEqual(f.j.priceReview(f.old.id),f.old);
 }finally{f.j.close();}
});
test('rounding reconfirmation preserves explicit activity choice',()=>{
 const f=reconfirmFixture(undefined,Date.now(),campaignChoice('限时抢购'));try{
  const r=f.generate();assert.deepEqual(r.campaignTarget,f.old.campaignTarget);assert.equal(r.type,'限时抢购');assert.equal(r.durationMs,172800000);
  f.approve(r);const plan=f.service.restorePlan(f.baseline,f.current);assert.equal(plan.type,'限时抢购');assert.equal(plan.durationMs,172800000);f.j.assertPricePlans(f.old.shopId,[plan]);
 }finally{f.j.close();}
});
test('declined proposal stays declined until explicit recalculate; old approved is immutable',()=>{
 const f=reconfirmFixture();try{
  const r=f.generate();f.service.decidePriceReview({reviewId:r.id,key:r.key,decision:'decline'});f.generate();assert.equal(f.j.priceReviews(f.old.shopId).length,2);
  f.service.decidePriceReview({reviewId:r.id,key:r.key,decision:'recalculate'});const next=f.generate();assert.notEqual(next.id,r.id);assert.deepEqual(f.j.priceReview(f.old.id),f.old);
 }finally{f.j.close();}
});
test('unknown tasks, changed current base and tampered old-price comparisons never permit reconfirmation',()=>{
 for(const mode of ['unknown','base','comparison']){const f=reconfirmFixture();try{
  if(mode==='unknown'){const t=f.j.enqueue(f.old.shopId,[f.plan],{complete:true,observedAt:f.now,lossKey:'unknown'},f.now);f.j.transition(t.id,'queued','prepared',{},f.now);f.j.transition(t.id,'prepared','submitting',{submitAttempts:1},f.now);f.j.recoverInterrupted(f.old.shopId);
   assert.throws(()=>f.service.restorePlan(f.baseline,f.current),{code:'PENDING'});assert.equal(f.j.priceReviews(f.old.shopId).length,1);
  }else if(mode==='base'){f.current.skus[0].baseFen++;assert.throws(()=>f.service.restorePlan(f.baseline,f.current));assert.equal(f.j.priceReviews(f.old.shopId).length,1);
  }else{const r=f.generate();r.rows[0].previousFen=6530;f.j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(r),r.id);assert.throws(()=>f.approve(r),{code:'PRICE_REVIEW_CHANGED'});assert.equal(f.j.priceTarget(f.old.shopId,f.old.productId).id,f.old.id);}
 }finally{f.j.close();}}
});

test('reconfirmation rejects expired, wrong key, changed target and unknown-task approvals',()=>{
 for(const mode of ['expired','key','target','unknown']){const f=reconfirmFixture();try{
  const r=f.generate();
  if(mode==='expired'){r.expiresAt=f.now-1;f.j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(r),r.id);}
  if(mode==='key')r.key='incorrect';
  if(mode==='target')f.j.db.prepare('DELETE FROM price_targets').run();
  if(mode==='unknown'){const t=f.j.enqueue(f.old.shopId,[f.plan],{complete:true,observedAt:f.now,lossKey:'unknown'},f.now);f.j.transition(t.id,'queued','prepared',{},f.now);f.j.transition(t.id,'prepared','submitting',{submitAttempts:1},f.now);}
  assert.throws(()=>f.approve(r),{code:mode==='expired'?'PRICE_REVIEW_EXPIRED':mode==='unknown'?'PENDING':'PRICE_REVIEW_CHANGED'});
  assert.deepEqual(f.j.priceReview(f.old.id),f.old);assert.equal(f.j.priceReview(r.id).status,'pending');
 }finally{f.j.close();}}
});
test('approved recalculation request preserves consent and amounts; expired pending gets a new identity',()=>{
 const f=reconfirmFixture();try{
  f.service.decidePriceReview({reviewId:f.old.id,key:f.old.key,decision:'recalculate'});assert.deepEqual(f.j.priceReview(f.old.id),f.old);
  const r=f.generate();r.expiresAt=f.now-1;f.j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(r),r.id);
  const next=f.generate();assert.notEqual(next.id,r.id);assert.equal(f.j.priceReview(r.id).status,'superseded');assert.deepEqual(f.j.priceReview(f.old.id),f.old);
 }finally{f.j.close();}
});

test('a previously absent SKU cannot fall back to historical prices outside the new confirmation',()=>{
 const f=reconfirmFixture();try{
  const r=f.generate(),approved=f.approve(r);
  const extra={...f.plan.skus[0],id:'3386359933583654',name:'返回的规格'};
  assert.throws(()=>applyPriceTarget({...f.plan,skus:[...f.plan.skus,extra]},approved),{code:'PRICE_APPROVAL_CHANGED'});
  const plan=f.service.restorePlan(f.baseline,f.current);plan.skus.push(extra);
  assert.throws(()=>f.j.assertPricePlans(f.old.shopId,[plan]),{code:'PRICE_APPROVAL_CHANGED'});
 }finally{f.j.close();}
});
