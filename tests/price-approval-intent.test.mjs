import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint} from '../src/policy.mjs';
import {priceOptions} from '../src/price-options.mjs';
import {createPriceApprovalIntent,validateFreshPriceIntent} from '../src/price-approval-intent.mjs';
import {getDualActivityDecision,makeDualActivityDecision,dualProbePlan} from '../src/dual-activity-recovery.mjs';
import {dualDraftObservation} from './helpers/dual-activity-fixture.mjs';
import {eroDualProposalFixture} from './helpers/ero-dual-proposal-fixture.mjs';
import {unresolvedDualFixture} from './helpers/unresolved-dual-fixture.mjs';
import {manualPriceOption} from '../src/manual-price-option.mjs';

const protectedState=j=>fingerprint(Object.fromEntries(['tasks','baselines','price_reviews','price_targets','submission_archives','submission_successors'].map(t=>[t,j.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])));
function fixture(t){const j=new Journal(':memory:');t.after(()=>j.close());const at=Date.now(),f=eroDualProposalFixture(j,{now:at}),now=at+120001,decision=getDualActivityDecision(j,f.plan.shopId,f.plan.productId,now),review=j.priceReview(decision.reviewIds['限时抢购']),option=priceOptions(review).find(o=>o.id==='original'),args={shopId:review.shopId,reviewId:review.id,key:review.key,decision:'approve',dualPairKey:decision.pairKey,optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:option.rows.map(r=>r.id)};return{...f,j,now,decision,review,option,args};}
const create=f=>createPriceApprovalIntent({review:f.review,decision:f.decision,option:f.option,args:f.args,now:f.now});
function fresh(f,{at=f.now+1000,capFen=11200}={}){
 const {fingerprint:old,...body}=f.plan,plan={...body,observedAt:at};plan.fingerprint=fingerprint(plan);
 const probes=f.probes.map(p=>{const task=structuredClone(p.task);task.plans=[dualProbePlan(plan,p.type,task.dualProbe.choices)];task.dualProbe.plan=structuredClone(plan);task.lossEvidence.observedAt=at;for(const loss of task.lossEvidence.priceRules){loss.observedAt=at;loss.removalEvidence.observedAt=at;}
  return{type:p.type,task,observation:dualDraftObservation(task,{now:at,errorsById:capFen==null?{}:{'5500000000000000103':['单品活动价￥210.56，需≤￥'+capFen/100]}})};
 });
 const made=makeDualActivityDecision({plan,probes,now:at,journal:f.j}),decision=f.j.recordDualActivityDecision(made,at),review=f.j.priceReview(decision.reviewIds['限时抢购']),option=review&&priceOptions(review).find(o=>o.id==='original');return{now:at,decision,review,option};
}

test('confirming a genuine expired proposal saves only exact bounded intent and changes no target or financial row',t=>{
 const f=fixture(t),before=protectedState(f.j),inputs=fingerprint({review:f.review,decision:f.decision,option:f.option,args:f.args}),intent=create(f);
 assert.equal(f.decision.requiresRevalidation,true);assert.equal(f.decision.approvalAllowed,false);assert.equal(intent.source,'human-exact-price-awaiting-revalidation');assert.equal(intent.authorizesSubmit,false);assert.equal(intent.authorizesPriceChange,false);assert.equal(intent.expiresAt-f.now,86400000);
 assert.equal(intent.desired.rows.find(r=>r.id==='5500000000000000103').saleFen,11200);assert.equal(intent.desired.type,'限时抢购');assert.equal(intent.key,fingerprint({...intent,key:undefined}));assert.equal(protectedState(f.j),before);assert.equal(fingerprint({review:f.review,decision:f.decision,option:f.option,args:f.args}),inputs);
});
test('only a genuinely fresh identical full proposal rebinds new review and pair arguments for the ordinary Journal approval',t=>{
 const f=fixture(t),intent=create(f),next=fresh(f),before=protectedState(f.j),result=validateFreshPriceIntent(intent,next);
 assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.authorizesSubmit,false);assert.equal(result.authorizesPriceChange,false);assert.equal(result.args.reviewId,next.review.id);assert.notEqual(result.args.reviewId,intent.reviewId);assert.equal(result.args.dualPairKey,next.decision.pairKey);assert.equal(result.args.optionKey,next.option.key);assert.equal(result.args.acceptBlockedPriceChange,true);assert.deepEqual(result.args.confirmedSkuIds,[...intent.consent.confirmedSkuIds]);assert.equal(protectedState(f.j),before);assert.equal(f.j.priceTarget(f.review.shopId,f.review.productId).id,f.target.id);
});
for(const mode of ['missing-risk','missing-blocked-consent','partial-skus','duplicate-skus','wrong-shop','wrong-product','wrong-review-key','wrong-pair','wrong-option-key','unavailable-option','unverified-option','incomplete-scheme','changed-row','long-expiry'])test('exact intent refuses '+mode,t=>{
 const f=fixture(t);
 if(mode==='missing-risk')f.args.acceptPriceAndRisk=false;if(mode==='missing-blocked-consent')f.args.acceptBlockedPriceChange=false;
 if(mode==='partial-skus')f.args.confirmedSkuIds.pop();if(mode==='duplicate-skus')f.args.confirmedSkuIds[1]=f.args.confirmedSkuIds[0];
 if(mode==='wrong-shop')f.args.shopId='900002';if(mode==='wrong-product')f.args.productId='300099';if(mode==='wrong-review-key')f.args.key='changed';if(mode==='wrong-pair')f.args.dualPairKey='changed';if(mode==='wrong-option-key')f.args.optionKey='changed';
 if(mode==='unavailable-option')f.option.available=false;if(mode==='unverified-option')f.option.validationStatus='unverified';if(mode==='incomplete-scheme')f.decision.schemes.find(s=>s.type==='限时抢购').candidateReady=false;
 if(mode==='changed-row')f.option.rows[0].saleFen++;if(mode==='long-expiry')f.args.intentExpiresAt=f.now+86400001;
 assert.throws(()=>create(f));assert.equal(f.j.priceTarget(f.review.shopId,f.review.productId).id,f.target.id);assert.equal(f.j.list(f.review.shopId).length,0);
});
test('a necessary reduction without its own complete candidate cannot be chosen even when the peer is complete',t=>{
 const f=fixture(t);f.option.activityType='限量抢购';assert.equal(f.decision.schemes.find(s=>s.type==='限量抢购').candidateReady,false);assert.throws(()=>create(f),{code:'PRICE_INTENT_CANDIDATE_INCOMPLETE'});
});
for(const mode of ['still-stale','changed-price','changed-context','changed-rule','changed-physical-quota','tampered-intent','expired-intent'])test('revalidation never approves an intent after '+mode,t=>{
 const f=fixture(t),intent=create(f);let next=mode==='still-stale'?{review:f.review,decision:f.decision,option:f.option,now:f.now}:fresh(f,{capFen:mode==='changed-price'?11100:11200});
 if(mode==='changed-context')next.decision.currentContext='0'.repeat(64);
 if(mode==='changed-rule')next.decision.schemes.find(s=>s.type==='限时抢购').review.rules={...next.decision.schemes[0].review.rules,orderMinutes:60};
 if(mode==='changed-physical-quota')next.decision.schemes.find(s=>s.type==='限时抢购').review.campaignTarget.activityLimit=1000;
 if(mode==='tampered-intent')intent.desired.rows[0].saleFen--;if(mode==='expired-intent')next.now=intent.expiresAt;
 const result=validateFreshPriceIntent(intent,next);assert.equal(result.ready,false);assert.equal(result.status,'needs-review');assert.equal(result.args,undefined);assert.equal(result.authorizesSubmit,false);assert.equal(f.j.priceTarget(f.review.shopId,f.review.productId).id,f.target.id);
});
test('a fresh non-reducing alternative cancels the old lowering path without approving a price or submitting',t=>{
 const f=fixture(t),intent=create(f),next=fresh(f,{capFen:null}),before=protectedState(f.j),result=validateFreshPriceIntent(intent,next);
 assert.equal(result.status,'automatic');assert.equal(result.ready,false);assert.equal(result.args,undefined);assert.equal(result.authorizesSubmit,false);assert.equal(protectedState(f.j),before);
});
test('a real scoped archive brand is required and cannot be restored by serializing a valid proposal',t=>{
 const j=new Journal(':memory:');t.after(()=>j.close());const at=Date.now(),f=unresolvedDualFixture(j,{now:at}),now=at+120001,decision=getDualActivityDecision(j,f.shopId,f.productId,now),review=j.priceReview(decision.reviewIds['限时抢购']),option=priceOptions(review).find(o=>o.id==='original'),args={shopId:f.shopId,reviewId:review.id,key:review.key,decision:'approve',dualPairKey:decision.pairKey,optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:option.rows.map(r=>r.id)};
 const intent=createPriceApprovalIntent({review,decision,option,args,now});assert.equal(intent.desired.type,'限时抢购');assert.equal(intent.authorizesSubmit,false);
 assert.throws(()=>createPriceApprovalIntent({review,decision:JSON.parse(JSON.stringify(decision)),option,args,now}),{code:'PRICE_INTENT_RECHECK_REQUIRED'});assert.equal(j.priceTarget(f.shopId,f.productId),null);
});
test('explicit manual discounts are rebound only to the same freshly verified exact full price table',t=>{
 const f=fixture(t);f.option=manualPriceOption(f.review,f.option.rows.map(r=>({id:r.id,discount:r.discount})),f.review.createdAt);f.args.optionId=f.option.id;f.args.optionKey=f.option.key;
 const intent=create(f),next=fresh(f);next.option=manualPriceOption(next.review,intent.desired.rows.map(r=>({id:r.id,discount:r.discount})),next.now);
 const result=validateFreshPriceIntent(intent,next);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.args.optionId,'manual-discount');assert.deepEqual(result.args.manualDiscounts,intent.desired.rows.map(r=>({id:r.id,discount:r.discount})));assert.equal(result.args.manualActivityType,'限时抢购');assert.equal(f.j.priceTarget(f.review.shopId,f.review.productId).id,f.target.id);
});
test('a limited-to-timed proposal keeps inert old top-level quota out of physical exact intent without altering source proofs',t=>{
 const f=fixture(t),oldEvidence=fingerprint(f.decision.probes),context=f.decision.currentContext;f.review.activityLimit=1000;f.decision.schemes.find(s=>s.type==='限时抢购').review.activityLimit=1000;
 const intent=create(f);assert.equal(intent.desired.activityLimit,null);assert.equal(intent.desired.rules.noLimit,true);assert.equal(f.review.activityLimit,1000);assert.equal(fingerprint(f.decision.probes),oldEvidence);assert.equal(intent.currentContext,context);
 const next=fresh(f);next.review.activityLimit=1000;next.decision.schemes.find(s=>s.type==='限时抢购').review.activityLimit=1000;
 const result=validateFreshPriceIntent(intent,next);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.authorizesSubmit,false);assert.equal(f.j.priceTarget(f.review.shopId,f.review.productId).id,f.target.id);
});
