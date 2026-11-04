import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {assertDualPriceBasis} from '../src/legacy-price-floor.mjs';
import {makeDualActivityDecision,validDualActivityApproval,assertDualProbeAllowed,getDualActivityDecision} from '../src/dual-activity-recovery.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';
import {applyCampaignPolicy} from '../src/campaign-policy.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {GuardianService} from '../src/service.mjs';
import {legacyPriceFloorFixture,legacyNativeProbe,legacyDraftObservation} from './helpers/legacy-price-floor-fixture.mjs';

const limited='限量抢购',timed='限时抢购';
const make=(f,probes)=>makeDualActivityDecision({journal:f.j,plan:f.plan,probes,legacyPriceFloor:assertDualPriceBasis(f.j,f.plan,f.now),now:f.now});
const store=(f,probes)=>f.j.recordDualActivityDecision(make(f,probes),f.now);

test('real service revalidates an unchanged legacy target into a new approval before any submission',async()=>{
 const f=legacyPriceFloorFixture();try{
  const calls=[],platform={journal:f.j,release:async()=>{},prepare:async task=>({observation:legacyDraftObservation(task,f.now)}),priceCheck:async function(task){calls.push(task);return DoudianPlatform.prototype.priceCheck.call(this,task);}};
  const service=new GuardianService({journal:f.j,platform,policy:f.policy,now:()=>f.now}),loss={productId:f.plan.productId,complete:true,active:false,observedAt:f.now,lossKey:'fresh-service-legacy-loss'};
  const final=await service.checkPriceRules(f.plan,loss),replacement=f.j.priceTarget(f.plan.shopId,f.plan.productId);
  assert.deepEqual(calls.map(t=>t.plans[0].type),[limited,timed]);assert.ok(calls.every(t=>t.dualProbe.legacyPriceFloor?.authorizesSubmit===false));
  assert.notEqual(replacement.id,f.approved.id,'even unchanged exact prices require a newly valid dual approval before execution');
  assert.equal(final.priceApprovalId,replacement.id);assert.equal(final.skus.at(-1).saleFen,2240);assert.ok(validDualActivityApproval(f.j,replacement));
  assert.doesNotThrow(()=>f.j.assertPricePlans(final.shopId,[final]));assert.equal(f.j.list(final.shopId).length,0,'approval alone is not a submitted or verified recovery');
 }finally{f.j.close();}
});

test('new independent exact-price drafts produce a new valid approval without reviving or rewriting the old target',()=>{
 const f=legacyPriceFloorFixture();try{
  const oldRow=f.j.db.prepare('SELECT body FROM price_reviews WHERE id=?').get(f.approved.id).body;
  const decision=store(f,[legacyNativeProbe(f,limited),legacyNativeProbe(f,timed)]);assert.equal(decision.valid,true);assert.equal(decision.selectedType,limited);
  const replacement=f.j.approveDualActivityDecision(f.plan.shopId,f.plan.productId,decision.pairKey,f.now);
  assert.notEqual(replacement.id,f.approved.id);assert.equal(replacement.automaticConsent.dualGrantId,f.grant.id);
  assert.deepEqual(replacement.rows.map(r=>r.saleFen),f.approved.rows.map(r=>r.saleFen));assert.equal(replacement.rows.at(-1).saleFen,2240);
  assert.ok(validDualActivityApproval(f.j,replacement));assert.deepEqual(replacement.legacyPriceFloor,replacement.dualSource.legacyPriceFloor);
  assert.equal(f.j.db.prepare('SELECT body FROM price_reviews WHERE id=?').get(f.approved.id).body,oldRow);
  assert.throws(()=>f.j.assertPricePlans(f.plan.shopId,[f.plan]),{code:'PRICE_APPROVAL_CHANGED'});
  const final=applyCampaignPolicy(applyPriceTarget(f.original,replacement),f.j);assert.doesNotThrow(()=>f.j.assertPricePlans(final.shopId,[final]));
  const task=f.j.enqueue(final.shopId,[final],{complete:true,observedAt:f.now,lossKey:'new-approval-fresh-independent-loss'},f.now);
  f.j.transition(task.id,'queued','prepared',{},f.now);const proof=proveDraft(task,legacyDraftObservation(task,f.now),f.now),submitted=f.j.beginSubmit(task.id,proof,f.now);
  assert.equal(submitted.phase,'submitting');assert.equal(submitted.submitAttempts,1);assert.equal(submitted.riskAttempts,0);
  assert.throws(()=>f.j.beginSubmit(task.id,proof,f.now));assert.equal(f.j.get(task.id).submitAttempts,1);
 }finally{f.j.close();}
});

test('the actual Platform.priceCheck gate accepts the canonical floor only for read drafts, and unknown blocks further probes',async()=>{
 const f=legacyPriceFloorFixture();try{
  const probe=legacyNativeProbe(f,timed);let prepared=0,released=0;
  const platform={journal:f.j,prepare:async()=>{prepared++;return{observation:probe.observation};},release:async()=>{released++;}};
  const observation=await DoudianPlatform.prototype.priceCheck.call(platform,probe.task);assert.equal(observation.complete,true);assert.equal(prepared,1);assert.equal(released,1);
  const missing=structuredClone(probe.task);delete missing.dualProbe.legacyPriceFloor;
  await assert.rejects(DoudianPlatform.prototype.priceCheck.call(platform,missing),{code:'LEGACY_PRICE_FLOOR_INVALID'});assert.equal(prepared,1);
  const task=f.j.enqueue(f.plan.shopId,[f.original],{complete:true,observedAt:f.now,lossKey:'existing-unknown-lock'},f.now),body={...task,submitAttempts:1,submittedAt:f.now};
  f.j.db.prepare('UPDATE tasks SET phase=?,body=? WHERE id=?').run('unknown',JSON.stringify(body),task.id);
  assert.throws(()=>assertDualProbeAllowed(f.j,probe.task,f.now),{code:'PENDING'});
  await assert.rejects(DoudianPlatform.prototype.priceCheck.call(platform,probe.task),{code:'PENDING'});assert.equal(prepared,1);
 }finally{f.j.close();}
});

test('a freshly accepted alternative type can replace the invalid target at the exact current prices',()=>{
 const f=legacyPriceFloorFixture();try{
  const decision=store(f,[legacyNativeProbe(f,limited,{errors:{'500010':['活动价不得高于20元']}}),legacyNativeProbe(f,timed)]);
  assert.equal(decision.selectedType,timed);const replacement=f.j.approveDualActivityDecision(f.plan.shopId,f.plan.productId,decision.pairKey,f.now);
  assert.equal(replacement.type,timed);assert.equal(replacement.rows.at(-1).saleFen,2240);assert.equal(validDualActivityApproval(f.j,replacement),true);
  const final=applyCampaignPolicy(applyPriceTarget(f.original,replacement),f.j);assert.equal(final.type,timed);assert.equal(final.durationMs,48*3600000);
  assert.equal(final.activityLimit==null,true);assert.doesNotThrow(()=>f.j.assertPricePlans(final.shopId,[final]));
 }finally{f.j.close();}
});

test('both lower candidates compare to the retained 22.40 floor rather than the historical 16.80 price',()=>{
 const f=legacyPriceFloorFixture();try{
  const errors={'500010':['活动价不得高于20元']},probes=[legacyNativeProbe(f,limited,{errors}),legacyNativeProbe(f,timed,{errors})];
  const decision=store(f,probes);assert.equal(decision.approvalAllowed,true);assert.equal(decision.selectedType,null);
  assert.ok(decision.schemes.every(s=>s.classification==='reduction-required'));
  for(const scheme of decision.schemes){const row=scheme.candidate.rows.find(r=>r.id==='500010');assert.equal(row.previousFen,2240);assert.equal(row.saleFen,1988);assert.ok(row.saleFen>1680&&row.saleFen<2240);}
  assert.throws(()=>f.j.approveDualActivityDecision(f.plan.shopId,f.plan.productId,decision.pairKey,f.now),{code:'DUAL_REDUCTION_REQUIRED'});
  assert.equal(f.j.priceTarget(f.plan.shopId,f.plan.productId).id,f.approved.id);assert.equal(f.j.list(f.plan.shopId).length,0);
 }finally{f.j.close();}
});

for(const mutation of ['missing-floor','different-floor','probe-floor','grant-disabled','stale-probe'])test('new legacy-target decisions reject or remain non-actionable on '+mutation,()=>{
 const f=legacyPriceFloorFixture();try{
  const probes=[legacyNativeProbe(f,limited),legacyNativeProbe(f,timed)];let decision=make(f,probes);
  if(mutation==='missing-floor'){delete decision.legacyPriceFloor;decision.pairKey=fingerprint({...decision,pairKey:undefined});assert.throws(()=>f.j.recordDualActivityDecision(decision,f.now),{code:'DUAL_PROBE_CHANGED'});}
  if(mutation==='different-floor'){decision.legacyPriceFloor=structuredClone(decision.legacyPriceFloor);decision.legacyPriceFloor.authorizesSubmit=true;decision.pairKey=fingerprint({...decision,pairKey:undefined});assert.throws(()=>f.j.recordDualActivityDecision(decision,f.now),{code:'DUAL_PROBE_CHANGED'});}
  if(mutation==='probe-floor'){delete probes[0].task.dualProbe.legacyPriceFloor;assert.throws(()=>make(f,probes),{code:'LEGACY_PRICE_FLOOR_INVALID'});}
  if(mutation==='grant-disabled'){f.j.putSettings('dual-activity-care-policy:'+f.plan.shopId,{enabled:false});assert.throws(()=>f.j.recordDualActivityDecision(decision,f.now),{code:'DUAL_ACTIVITY_CONSENT_REQUIRED'});}
  if(mutation==='stale-probe'){for(const probe of probes)probe.observation.observedAt=f.now-120001;decision=make(f,probes);assert.equal(decision.approvalAllowed,false);assert.equal(decision.selectedType,null);assert.ok(decision.schemes.every(s=>s.classification==='pending'));}
  assert.equal(f.j.priceTarget(f.plan.shopId,f.plan.productId).id,f.approved.id);assert.equal(f.j.list(f.plan.shopId).length,0);
 }finally{f.j.close();}
});

test('a later altered old review or an altered floor cannot keep a new target valid by resealing JSON alone',()=>{
 const f=legacyPriceFloorFixture();try{
  const decision=store(f,[legacyNativeProbe(f,limited),legacyNativeProbe(f,timed)]),replacement=f.j.approveDualActivityDecision(f.plan.shopId,f.plan.productId,decision.pairKey,f.now);
  const altered=structuredClone(replacement);altered.legacyPriceFloor.legacyReview.rows.at(-1).saleFen=1680;assert.equal(validDualActivityApproval(f.j,altered),false);
  const old=structuredClone(f.approved);old.automaticConsent.continueGuardingExactPrices=false;f.j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(old),old.id);
  assert.equal(validDualActivityApproval(f.j,replacement),false);const plan=applyCampaignPolicy(applyPriceTarget(f.original,replacement),f.j);
  assert.throws(()=>f.j.assertPricePlans(plan.shopId,[plan]),{code:'PRICE_APPROVAL_CHANGED'});
 }finally{f.j.close();}
});
