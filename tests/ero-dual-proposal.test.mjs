import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint} from '../src/policy.mjs';
import {makeNecessaryReductionEvidence} from '../src/price-review.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';
import {makeDualActivityDecision,getDualActivityDecision,dualPriceApprovalReady,dualPriceProposalReady,displayProposalPricingContext} from '../src/dual-activity-recovery.mjs';
import {manualPriceOption} from '../src/manual-price-option.mjs';
import {eroDualProposalFixture} from './helpers/ero-dual-proposal-fixture.mjs';

test('both complete ERO drafts prove the CTO reduction, while an ambiguous limited ratio never becomes an approvable candidate',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),d=f.decision,timed=d.schemes.find(s=>s.type==='限时抢购'),limited=d.schemes.find(s=>s.type==='限量抢购');
  assert.equal(d.valid,true);assert.equal(dualPriceApprovalReady(d),true);assert.equal(dualPriceProposalReady(d),true);assert.equal(d.selectedType,null);
  assert.equal(timed.classification,'reduction-required');assert.equal(limited.classification,'reduction-required');assert.equal(limited.candidateReady,false);assert.equal(limited.candidate,null);assert.equal(limited.review,null);assert.equal(limited.reviewId,null);
  const proof=limited.necessaryReductionEvidence;assert.equal(proof.source,'live-platform-necessary-sku-reduction');assert.deepEqual(proof.allSkuIds,f.plan.skus.map(s=>s.id));assert.equal(proof.rows.length,1);assert.equal(proof.rows[0].id,'5500000000000000103');assert.equal(proof.rows[0].guardedFen,21056);assert.equal(proof.rows[0].maximumExplicitPriceFen,11200);assert.equal(proof.rows[0].minimumReductionFen,9856);assert.equal(proof.activityType,'限量抢购');assert.equal(proof.probeFingerprint,fingerprint(f.probes[1].observation));assert.match(limited.ambiguousRemovalEvidence.removal.reason,/3.5.*\n.*5.3/);
  assert.equal(timed.candidate.rows.find(r=>r.id==='5500000000000000103').saleFen,11200);assert.equal(timed.candidate.rows.filter(r=>r.saleFen!==r.previousFen).length,1);assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId).id,f.target.id);assert.equal(j.list(f.plan.shopId).length,0);
 }finally{j.close();}
});
test('necessary reduction evidence alone in both schemes cannot offer any price approval',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j,{recordDecision:false}),p=f.probes[0];p.task.lossEvidence.priceRules[0].removalEvidence.activityType='限时抢购';const d=makeDualActivityDecision({plan:f.plan,probes:f.probes,now:f.now(),journal:j});assert.ok(d.schemes.every(s=>s.classification==='reduction-required'&&s.candidateReady===false));assert.equal(d.approvalAllowed,false);assert.equal(d.schemes.every(s=>s.candidate===null),true);}finally{j.close();}
});
for(const fault of ['unknown-row-error','unmapped-warning','missing-sku','wrong-sku-price','wrong-sku-id','stale'])test('an ambiguous export cannot turn incomplete or vague row evidence into required reduction: '+fault,()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j,{recordDecision:false}),p=f.probes[1];
  if(fault==='unknown-row-error')p.observation.rows[2].errors.push('请检查价格');
  if(fault==='unmapped-warning')p.observation.warnings.push('存在尚未核对的活动限制');
  if(fault==='missing-sku')p.observation.rows.pop();
  if(fault==='wrong-sku-price')p.observation.rows[2].saleFen--;
  if(fault==='wrong-sku-id')p.observation.rows[2].id='999999';
  if(fault==='stale')p.observation.observedAt-=120001;
  const d=makeDualActivityDecision({plan:f.plan,probes:f.probes,now:f.now(),journal:j}),s=d.schemes.find(s=>s.type==='限量抢购');assert.equal(s.classification,'pending');assert.equal(s.necessaryReductionEvidence,undefined);assert.equal(d.approvalAllowed,false);
 }finally{j.close();}
});
test('a direct lower bound or equal upper cap cannot masquerade as necessary reduction',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j,{recordDecision:false}),p=f.probes[1];
  for(const text of ['活动价不得低于200元','单品活动价￥210.56，需≤￥211']){p.observation.rows[2].errors=[text];p.observation.warnings=[text];assert.equal(makeNecessaryReductionEvidence(p.task,p.observation,f.now()),null);const d=makeDualActivityDecision({plan:f.plan,probes:f.probes,now:f.now(),journal:j});assert.equal(d.schemes.find(s=>s.type==='限量抢购').classification,'pending');assert.equal(d.approvalAllowed,false);}
 }finally{j.close();}
});
test('expired execution evidence keeps exact proposal facts visible but cannot approve or select an automatic recovery',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),at=f.now()+121000,d=getDualActivityDecision(j,f.plan.shopId,f.plan.productId,at);assert.equal(d.valid,true);assert.equal(d.requiresRevalidation,true);assert.equal(d.evidenceFresh,false);assert.equal(d.approvalReady,false);assert.equal(d.approvalAllowed,false);assert.equal(d.confirmationRequired,true);assert.equal(dualPriceApprovalReady(d),false);assert.equal(dualPriceProposalReady(d),true);assert.equal(d.selectedType,null);assert.deepEqual(d.schemes.map(s=>s.classification),['reduction-required','reduction-required']);assert.equal(d.schemes[0].candidate.rows[2].saleFen,11200);assert.equal(d.schemes[1].candidateReady,false);
  const r=j.priceReview(d.reviewIds['限时抢购']);assert.throws(()=>j.decidePriceReview(f.plan.shopId,r.id,r.key,'approve',{confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint},at));assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId).id,f.target.id);
 }finally{j.close();}
});
test('a changed current target still invalidates even a display-only proposal',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),next={...structuredClone(f.target),id:'other-current-target'};j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(next.id,next.shopId,next.productId,next.status,JSON.stringify(next),f.now());j.db.prepare('UPDATE price_targets SET review=? WHERE shop=? AND product=?').run(next.id,next.shopId,next.productId);const d=getDualActivityDecision(j,next.shopId,next.productId,f.now()+121000);assert.equal(d.valid,false);assert.equal(dualPriceProposalReady(d),false);assert.equal(d.approvalAllowed,false);}finally{j.close();}
});
test('an expired non-reducing finding never continues its old automatic selection',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j,{capFen:null}),d=getDualActivityDecision(j,f.plan.shopId,f.plan.productId,f.now()+121000);assert.equal(f.decision.selectedType,'限时抢购');assert.equal(d.selectedType,null);assert.equal(d.requiresRevalidation,true);assert.equal(dualPriceApprovalReady(d),false);assert.equal(dualPriceProposalReady(d),false);assert.throws(()=>j.approveDualActivityDecision(f.plan.shopId,f.plan.productId,d.pairKey,f.now()+121000));assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId).id,f.target.id);}finally{j.close();}
});
test('display context computes the exact old candidate as of its original time without extending any evidence or approval',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),now=f.now()+121000,d=getDualActivityDecision(j,f.plan.shopId,f.plan.productId,now),r=j.priceReview(d.reviewIds['限时抢购']),before=fingerprint({d,r}),ctx=displayProposalPricingContext(d,r,now),discounts=r.rows.map(s=>({id:s.id,discount:s.discount}));
  assert.equal(ctx.now,d.createdAt);assert.equal(ctx.pricingAsOf,d.createdAt);assert.equal(ctx.displayOnly,true);assert.equal(ctx.authorizesSubmit,false);assert.equal(ctx.authorizesPriceApproval,false);assert.equal(ctx.requiresRevalidation,true);assert.deepEqual(ctx.allowedTypes,['限时抢购']);assert.equal(ctx.dualDecision.approvalAllowed,false);
  assert.throws(()=>manualPriceOption(r,discounts,now),{code:'PRICE_REVIEW_EXPIRED'});const option=manualPriceOption(r,discounts,ctx.now);assert.equal(option.rows[2].saleFen,11200);assert.equal(fingerprint({d,r}),before);assert.equal(dualPriceApprovalReady(d),false);assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId).id,f.target.id);
 }finally{j.close();}
});
test('display context cannot manufacture a selectable limited candidate or accept altered proposal rows',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),d=getDualActivityDecision(j,f.plan.shopId,f.plan.productId,f.now()+121000),r=j.priceReview(d.reviewIds['限时抢购']);
  assert.throws(()=>displayProposalPricingContext(d,{...r,type:'限量抢购'},f.now()+121000),{code:'DUAL_PROPOSAL_UNAVAILABLE'});const changed=structuredClone(r);changed.rows[0].saleFen--;assert.throws(()=>displayProposalPricingContext(d,changed,f.now()+121000),{code:'DUAL_PROPOSAL_UNAVAILABLE'});
 }finally{j.close();}
});
test('applying a fresh target to an already guarded plan preserves immutable historical discounts',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),timed=f.decision.schemes.find(s=>s.type==='限时抢购'),next={...structuredClone(timed.review),id:'fresh-human-timed',key:'fresh-exact-key',status:'approved'};
  const result=applyPriceTarget(f.plan,next);assert.equal(result.priceApprovalId,next.id);assert.equal(result.skus[2].discount,50);assert.equal(result.skus[2].originalDiscount,50);assert.equal(result.skus[3].discount,43);assert.equal(result.skus[3].originalDiscount,50);assert.equal(result.approvedRiskAllowed,true);
  const forged=structuredClone(next);forged.rows[2].historicalDiscount=94;assert.throws(()=>applyPriceTarget(f.plan,forged),{code:'PRICE_APPROVAL_CHANGED'});
 }finally{j.close();}
});
test('rebinding identical current prices does not discard their existing exact-price risk requirement',()=>{
 const j=new Journal(':memory:');try{const f=eroDualProposalFixture(j),next={...structuredClone(f.target),id:'fresh-same-current-prices',key:'fresh-same-key'},result=applyPriceTarget(f.plan,next);assert.deepEqual(result.skus.map(s=>[s.discount,s.originalDiscount,s.saleFen]),f.plan.skus.map(s=>[s.discount,s.originalDiscount,s.saleFen]));assert.equal(result.originalRiskAllowed,false);assert.equal(result.approvedRiskAllowed,true);}finally{j.close();}
});
