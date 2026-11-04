import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {assertDualPriceBasis,validateLegacyPriceFloor} from '../src/legacy-price-floor.mjs';
import {validCarePriceApproval,carePriceCandidate} from '../src/care-recovery-policy.mjs';
import {legacyPriceFloorFixture,legacyDraftObservation} from './helpers/legacy-price-floor-fixture.mjs';

test('the exact sanitized legacy ten-SKU target is only an immutable dry-read floor',()=>{
 const f=legacyPriceFloorFixture();try{
  assert.equal(f.current.skus.length,10);assert.ok(f.current.skus.every(s=>s.id===null&&s.idSource==='unavailable-in-create-form'));
  assert.equal(f.approved.rows.at(-1).previousFen,1680);assert.equal(f.approved.rows.at(-1).saleFen,2240);
  assert.equal(validCarePriceApproval(f.j,f.approved),false);assert.throws(()=>carePriceCandidate(f.approved.careSource,{},f.approved.approvedAt),{code:'REMOVAL_RULE_AMBIGUOUS'});
  assert.throws(()=>f.j.assertPricePlans(f.plan.shopId,[f.plan]),{code:'PRICE_APPROVAL_CHANGED'});
  const proof=assertDualPriceBasis(f.j,f.plan,f.now);assert.equal(proof.authorizesSubmit,false);assert.equal(proof.requiresFreshDualProofs,true);
  assert.equal(proof.reasonCode,'REMOVAL_RULE_AMBIGUOUS');assert.deepEqual(proof.legacyReview,f.approved);assert.deepEqual(proof.plan,f.plan);
  assert.ok(Object.isFrozen(proof)&&Object.isFrozen(proof.legacyReview.rows[0]));assert.throws(()=>{proof.legacyReview.rows.at(-1).saleFen=1680;},TypeError);
  assert.deepEqual(validateLegacyPriceFloor(f.j,f.plan,JSON.parse(JSON.stringify(proof)),{now:f.now}),proof);
  assert.equal(assertDualPriceBasis(f.j,f.original,f.now),null,'a normal original plan retains the existing strict contract');
 }finally{f.j.close();}
});

test('a floor never permits the old target to cross a real durable beginSubmit boundary',()=>{
 const f=legacyPriceFloorFixture();try{
  assert.ok(assertDualPriceBasis(f.j,f.plan,f.now));
  const task=f.j.enqueue(f.plan.shopId,[f.plan],{complete:true,observedAt:f.now,lossKey:'fresh-old-target-loss'},f.now),observation=legacyDraftObservation(task,f.now);
  const proof=proveDraft(task,observation,f.now);f.j.transition(task.id,'queued','prepared',{},f.now);
  assert.throws(()=>f.j.beginSubmit(task.id,proof,f.now),{code:'PRICE_APPROVAL_CHANGED'});
  assert.equal(f.j.get(task.id).submitAttempts,0);assert.equal(f.j.get(task.id).riskAttempts,0);assert.equal(f.j.get(task.id).phase,'prepared');
 }finally{f.j.close();}
});

for(const mutation of ['shop','history','plan-price','plan-type','duration','quantity','fingerprint','target-pointer','missing-sku','grant','source-proof','source-key','approval-time','price-row'])test('legacy dry basis rejects '+mutation,()=>{
 const f=legacyPriceFloorFixture();try{
  const plan=structuredClone(f.plan),review=structuredClone(f.approved);
  if(mutation==='shop')plan.shopId='900002';
  if(mutation==='history')plan.historicalFingerprint='b'.repeat(64);
  if(mutation==='plan-price')plan.skus.at(-1).saleFen--;
  if(mutation==='plan-type')plan.type='限时抢购';
  if(mutation==='duration'){plan.durationMs-=1000;plan.fingerprint=fingerprint({...plan,fingerprint:undefined});}
  if(mutation==='quantity'){plan.activityLimit--;plan.fingerprint=fingerprint({...plan,fingerprint:undefined});}
  if(mutation==='fingerprint')plan.fingerprint='a'.repeat(64);
  if(mutation==='target-pointer')f.j.db.prepare('DELETE FROM price_targets WHERE shop=? AND product=?').run(plan.shopId,plan.productId);
  if(mutation==='missing-sku')plan.skus.pop();
  if(mutation==='grant'){const key='care-recovery-grant:'+plan.shopId+':'+review.automaticConsent.careGrantId,grant=f.j.settings(key);f.j.putSettings(key,{...grant,allowMatchedRisk:false});}
  if(mutation==='source-proof')review.careSource.sourceProof.sha256='invalid';
  if(mutation==='source-key')review.careSource.key='b'.repeat(64);
  if(mutation==='approval-time')review.approvedAt=review.careSource.expiresAt+1;
  if(mutation==='price-row')review.rows.at(-1).saleFen--;
  if(['source-proof','source-key','approval-time','price-row'].includes(mutation)){
   review.automaticConsent.sourceFingerprint=fingerprint(review.careSource);review.automaticConsent.targetsFingerprint=fingerprint(review.rows);
   f.j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(review),review.id);
  }
  assert.throws(()=>assertDualPriceBasis(f.j,plan,f.now));
 }finally{f.j.close();}
});

test('an exact floor proof cannot be replaced by rekeyed JSON and historical replay never grants submission',()=>{
 const f=legacyPriceFloorFixture();try{
  const proof=assertDualPriceBasis(f.j,f.plan,f.now),altered=structuredClone(proof);altered.legacyReview.rows.at(-1).saleFen=1680;altered.key=fingerprint({...altered,key:undefined});
  assert.throws(()=>validateLegacyPriceFloor(f.j,f.plan,altered,{now:f.now}),{code:'LEGACY_PRICE_FLOOR_INVALID'});
  f.j.db.prepare('DELETE FROM price_targets WHERE shop=? AND product=?').run(f.plan.shopId,f.plan.productId);
  assert.throws(()=>validateLegacyPriceFloor(f.j,f.plan,proof,{now:f.now}),{code:'LEGACY_PRICE_FLOOR_INVALID'});
  assert.deepEqual(validateLegacyPriceFloor(f.j,f.plan,proof,{requireCurrentTarget:false,now:f.now}),proof);
  assert.throws(()=>f.j.assertPricePlans(f.plan.shopId,[f.plan]),{code:'PRICE_APPROVAL_CHANGED'});
 }finally{f.j.close();}
});
