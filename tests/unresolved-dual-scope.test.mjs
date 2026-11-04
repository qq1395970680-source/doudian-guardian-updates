import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';
import {applyCampaignPolicy} from '../src/campaign-policy.mjs';
import {makeDualActivityDecision,getDualActivityDecision,dualPriceApprovalReady,validDualActivityApproval,dualProbePlan} from '../src/dual-activity-recovery.mjs';
import {unresolvedDualFixture} from './helpers/unresolved-dual-fixture.mjs';
import {dualDraftObservation} from './helpers/dual-activity-fixture.mjs';

function fixture(t,options){const journal=new Journal(':memory:');t.after(()=>journal.close());return unresolvedDualFixture(journal,options);}
test('a real archived timed-only quota restriction exposes only its independently proved lowering for explicit confirmation',t=>{
 const f=fixture(t),d=f.decision;assert.equal(d.valid,true,JSON.stringify(d));assert.equal(d.approvalAllowed,true);assert.equal(dualPriceApprovalReady(d),true);
 const excluded=d.schemes.find(s=>s.type==='限量抢购');assert.equal(excluded.classification,'unavailable');assert.equal(excluded.scopeExcluded,true);assert.match(excluded.reason,/额度/);assert.equal(excluded.review,null);assert.equal(excluded.candidate,undefined);assert.equal(d.selectedType,null);
 const review=f.journal.priceReview(d.reviewIds['限时抢购']);assert.ok(review.rows.some(s=>s.saleFen<s.previousFen));assert.equal(f.journal.priceTarget(f.shopId,f.productId),null);
 const approved=f.journal.decidePriceReview(f.shopId,review.id,review.key,'approve',{acceptPriceAndRisk:true,confirmedSkuIds:review.rows.map(s=>s.id),historicalFingerprint:review.historicalFingerprint},f.now);
 assert.equal(approved.type,'限时抢购');assert.equal(approved.status,'approved');assert.equal(approved.dualManualSource.scopeRestriction.key,f.archive.closure.key);assert.equal(f.journal.get(f.task.id).phase,'blocked');assert.equal(f.journal.get(f.task.id).submitAttempts,1);
});
test('a forbidden limited non-reducing candidate never beats an allowed timed non-reducing candidate',t=>{
 const f=fixture(t,{timedCapFen:null});assert.equal(f.decision.selectedType,'限时抢购');assert.equal(f.decision.approvalAllowed,false);
 const approved=f.journal.approveDualActivityDecision(f.shopId,f.productId,f.decision.pairKey,f.now);assert.equal(approved.type,'限时抢购');assert.equal(approved.dualSource.scopeRestriction.key,f.archive.closure.key);assert.equal(validDualActivityApproval(f.journal,approved),true);
});
test('a caller cannot inject allowedTypes without the full matching Journal archive',t=>{
 const f=fixture(t),options={plan:f.plan,probes:f.probes,now:f.now,scopeRestriction:f.archive.closure};
 assert.throws(()=>makeDualActivityDecision(options),{code:'DUAL_SCOPE_INVALID'});
 assert.throws(()=>makeDualActivityDecision({...options,journal:{unresolvedRecovery:()=>null}}),{code:'DUAL_SCOPE_INVALID'});
 const changed=structuredClone(f.archive.closure);changed.perProduct[0].allowedTypes=['限时抢购','限量抢购'];changed.key=fingerprint({...changed,key:undefined});
 assert.throws(()=>makeDualActivityDecision({...options,journal:f.journal,scopeRestriction:changed}),{code:'DUAL_SCOPE_INVALID'});
});
test('serialized scopeExcluded payloads cannot manufacture the private verified-archive marker',t=>{
 const f=fixture(t),payload=JSON.parse(JSON.stringify(f.decision));assert.equal(payload.valid,true);assert.equal(payload.approvalAllowed,true);assert.equal(dualPriceApprovalReady(payload),false);
 payload.schemes.forEach(s=>s.classification='reduction-required');assert.equal(dualPriceApprovalReady(payload),false);
});
test('replay rejects a missing archive or expired incident rather than silently dropping the scope',t=>{
 const f=fixture(t);assert.equal(dualPriceApprovalReady(getDualActivityDecision(f.journal,f.shopId,f.productId,f.now)),true);
 assert.equal(getDualActivityDecision(f.journal,f.shopId,f.productId,f.archive.closure.consentExpiresAt).valid,false);
 f.journal.unresolvedRecovery=()=>null;const unavailable=getDualActivityDecision(f.journal,f.shopId,f.productId,f.now);assert.equal(unavailable.valid,false);assert.equal(unavailable.approvalAllowed,false);
});
test('an excluded quantity scheme cannot turn an unread allowed scheme into a human lowering decision',t=>{
 const f=fixture(t),probes=f.probes.filter(p=>p.type==='限量抢购'),made=makeDualActivityDecision({plan:f.plan,probes,now:f.now,scopeRestriction:f.archive.closure,journal:f.journal});
 assert.equal(made.approvalAllowed,false);assert.equal(made.selectedType,null);assert.equal(made.schemes.find(s=>s.type==='限时抢购').classification,'pending');
});

function originalTrial(f){
 const probes=structuredClone(f.probes),entry=probes.find(p=>p.type==='限时抢购'),reason=['26','3.5','5.3'].map(r=>`该商品各SKU售卖价，最高价需在最低价的${r}倍以内，请修改后再提交。`).join('\n'),record={productId:f.productId,name:f.plan.name,reason};
 entry.observation=dualDraftObservation(entry.task,{now:f.now});
 entry.task.lossEvidence={priceRules:[{complete:true,active:false,observedAt:f.now,lossKey:'fresh-original-trial',removal:record,removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:f.shopId,campaignId:f.baseline.campaignId,activityType:'限时抢购',observedAt:f.now,sha256:'a'.repeat(64),record:structuredClone(record)}}]};
 return{entry,probes,options:{plan:f.plan,probes,now:f.now,scopeRestriction:f.archive.closure,journal:f.journal}};
}
test('a real current archive admits one unchanged original-price attempt while retaining the ambiguous raw export and excluding new quota',t=>{
 const f=fixture(t,{recordDecision:false}),trial=originalTrial(f),made=makeDualActivityDecision(trial.options),timed=made.schemes[0];
 assert.equal(made.selectedType,'限时抢购');assert.equal(made.approvalAllowed,false);assert.equal(timed.originalPriceAttemptOnly,true);assert.equal(timed.unchanged,true);assert.match(timed.reason,/尚未恢复成功/);
 assert.deepEqual(timed.review.ambiguousRemovalEvidence,trial.entry.task.lossEvidence.priceRules[0]);assert.deepEqual(made.probes,trial.probes);
 assert.ok(timed.candidate.rows.every(r=>r.saleFen===r.previousFen&&r.discount===r.previousDiscount));assert.equal(made.schemes[1].scopeExcluded,true);
 const saved=f.journal.recordDualActivityDecision(made,f.now),approved=f.journal.approveDualActivityDecision(f.shopId,f.productId,saved.pairKey,f.now);
 assert.equal(approved.originalPriceAttemptOnly,true);assert.equal(validDualActivityApproval(f.journal,approved),true);assert.equal(f.journal.list(f.shopId).filter(t=>t.phase==='verified').length,0);assert.equal(f.journal.get(f.task.id).submitAttempts,1);
});
for(const mode of ['sku-error','warning','stale-draft','stale-export','incomplete-draft','changed-price','consumed-successor'])test('original-price trial stays blocked for '+mode,t=>{
 const f=fixture(t,{recordDecision:false}),trial=originalTrial(f);
 if(mode==='sku-error'){trial.entry.observation.rows[0].errors=['活动价不得高于59元'];trial.entry.observation.warnings=['活动价不得高于59元'];}
 if(mode==='warning')trial.entry.observation.warnings=['平台规则尚未完成核验'];
 if(mode==='stale-draft')trial.entry.observation.observedAt=f.now-120001;
 if(mode==='stale-export')trial.entry.task.lossEvidence.priceRules[0].removalEvidence.observedAt=f.now-120001;
 if(mode==='incomplete-draft')trial.entry.observation.complete=false;
 if(mode==='changed-price'){trial.options.plan=structuredClone(f.plan);trial.options.plan.skus[0].saleFen--;}
 if(mode==='consumed-successor'){const read=f.journal.unresolvedRecovery.bind(f.journal);f.journal.unresolvedRecovery=id=>({...read(id),successor:{taskId:'already-submitted',submittedAt:f.now-1,task:{submitAttempts:1,riskAttempts:0}}});}
 const d=makeDualActivityDecision(trial.options);assert.equal(d.selectedType,null);assert.equal(d.approvalAllowed,false);if(mode==='sku-error'){assert.equal(d.schemes[0].classification,'reduction-required');assert.equal(d.schemes[0].candidateReady,false);assert.equal(d.schemes[0].candidate,null);assert.ok(d.schemes[0].necessaryReductionEvidence.rows.length>0);}else{assert.equal(d.schemes[0].classification,'pending');assert.equal(d.schemes[0].candidate,undefined);}
});
test('a limited current approved target switches to timed without changing prices and replays after the actual one-shot beginSubmit',t=>{
 const f=fixture(t,{recordDecision:false}),limited=dualProbePlan(f.plan,'限量抢购'),rows=limited.skus.map(s=>({id:s.id,name:s.name,baseFen:s.baseFen,historicalDiscount:s.discount,previousDiscount:s.discount,previousFen:s.saleFen,discount:s.discount,saleFen:s.saleFen,bounds:{},evidence:[]}));
 const prior={id:'prior-approved-limited-target',shopId:f.shopId,productId:f.productId,historicalFingerprint:f.plan.historicalFingerprint,key:'prior-limited-exact-prices',type:'限量抢购',rules:limited.rules,campaignTarget:limited.campaignTarget,status:'approved',approvedAt:f.now-10,rows,consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true}};
 f.journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(prior.id,f.shopId,f.productId,'approved',JSON.stringify(prior),f.now-10);f.journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(f.shopId,f.productId,prior.id);
 const guarded=applyCampaignPolicy(applyPriceTarget(f.plan,prior),f.journal),probes=f.probes.map(entry=>{const task={...structuredClone(entry.task),plans:[dualProbePlan(guarded,entry.type)],dualProbe:{...entry.task.dualProbe,plan:guarded}};return{type:entry.type,task,observation:dualDraftObservation(task,{now:f.now})};});
 const trial=originalTrial({...f,plan:guarded,probes}),made=makeDualActivityDecision(trial.options);assert.equal(made.originalPriceAttemptOnly,true);assert.equal(made.selectedType,'限时抢购');
 const saved=f.journal.recordDualActivityDecision(made,f.now),approved=f.journal.approveDualActivityDecision(f.shopId,f.productId,saved.pairKey,f.now);
 assert.equal(approved.type,'限时抢购');assert.equal(approved.previousApprovalId,prior.id);assert.equal(validDualActivityApproval(f.journal,approved),true);
 const execution=applyCampaignPolicy(applyPriceTarget(f.plan,approved),f.journal);f.journal.assertPricePlans(f.shopId,[execution]);
 const next=f.journal.enqueue(f.shopId,[execution],{complete:true,observedAt:f.now,lossKey:'fresh-original-price-loss',unresolvedRecoveryClosureId:f.archive.id},f.now+1);
 f.journal.transition(next.id,'queued','prepared',{},f.now+1);f.journal.beginSubmit(next.id,proveDraft(next,dualDraftObservation(next,{now:f.now+2}),f.now+2),f.now+2);
 assert.equal(f.journal.get(next.id).submitAttempts,1);assert.equal(f.journal.unresolvedRecovery(f.task.id).successor.submittedAt,f.now+2);
 assert.equal(validDualActivityApproval(f.journal,approved),true);f.journal.assertPricePlans(f.shopId,[execution]);
 assert.throws(()=>f.journal.beginSubmit(next.id,proveDraft(next,dualDraftObservation(next,{now:f.now+3}),f.now+3),f.now+3));
 assert.equal(f.journal.get(f.task.id).phase,'blocked');assert.equal(f.journal.get(f.task.id).submitAttempts,1);assert.equal(f.journal.get(next.id).phase,'submitting');
});
