import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint,planOriginalRestore} from '../src/policy.mjs';
import {blockerPriceOptions} from '../src/activity-price-comparison.mjs';
import {activeDualActivityCareGrant,dualProbePlan,getDualActivityDecision,makeDualActivityDecision,displayProposalPricingContext} from '../src/dual-activity-recovery.mjs';
import {recoveryRequests} from '../src/recovery-requests.mjs';
import {eroDualProposalFixture} from './helpers/ero-dual-proposal-fixture.mjs';
import {dualDecisionFixture,dualDraftObservation} from './helpers/dual-activity-fixture.mjs';

const targetState=(j,shop)=>fingerprint({targets:j.db.prepare('SELECT * FROM price_targets WHERE shop=? ORDER BY product').all(shop),approved:j.priceReviews(shop).filter(r=>r.status==='approved')});
function fixture(t,{ero=true}={}){
 const journal=new Journal(':memory:'),f=ero?eroDualProposalFixture(journal):dualDecisionFixture(journal,{caps:{'限时抢购':5800,'限量抢购':5900}});
 f.state.capFen=11200;f.state.failTypes=new Set();f.state.readPrices=[];
 if(ero){
  f.platform.loss=async()=>({...structuredClone(f.loss),observedAt:f.now(),removalEvidence:{...structuredClone(f.loss.removalEvidence),observedAt:f.now()}});
  f.platform.priceCheck=async task=>{const type=task.plans[0].type;f.state.dualReads.push(type);f.state.readPrices.push({type,prices:task.plans[0].skus.map(s=>({id:s.id,discount:s.discount,saleFen:s.saleFen}))});
   if(f.state.failTypes.has(type))throw Object.assign(Error('fixture platform price query is pending'),{code:'READ_OPERATION_TIMEOUT'});
   const errorsById=f.state.capFen==null?{}:{'5500000000000000103':['单品活动价￥210.56，需≤￥'+f.state.capFen/100]};return dualDraftObservation(task,{now:f.now(),errorsById});};
 }
 const service=new GuardianService({journal,platform:f.platform,policy:f.policy,now:f.now,immediate:false});t.after(()=>{service.stop();journal.close();});
 return{...f,journal,service};
}
function consent(f,{peer=false}={}){
 const d=getDualActivityDecision(f.journal,f.policy.shopId,f.baseline.productId,f.now()),review=f.journal.priceReview(d.reviewIds[d.plan.type]||Object.values(d.reviewIds)[0]),context={...displayProposalPricingContext(d,review,f.now()),reviews:f.journal.priceReviews(f.policy.shopId),tasks:f.journal.list(f.policy.shopId)};
 const options=blockerPriceOptions(review,context),option=options.find(o=>o.available&&(o.activityType!==review.type)===peer&&o.id.endsWith('original'))||options.find(o=>o.available&&(o.activityType!==review.type)===peer);
 assert.ok(option);return{review,decision:d,option,args:{shopId:review.shopId,reviewId:review.id,key:review.key,dualPairKey:d.pairKey,decision:'approve',optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:review.rows.map(r=>r.id)}};
}

test('a real ERO dual inspection exposes only timed exact prices and never changes the human target before consent',async t=>{
 const f=fixture(t),before=targetState(f.journal,f.policy.shopId),oldRows=structuredClone(f.target.rows),loss=await f.platform.loss(f.baseline,{fresh:true}),current=await f.platform.precheck(f.baseline),plan=f.service.restorePlan(f.baseline,current),decision=await f.service.inspectDualRecoveryPlan(plan,loss);
 assert.deepEqual([...new Set(f.state.dualReads)].sort(),['限时抢购','限量抢购'].sort());assert.equal(f.state.dualReads.length,2);assert.equal(decision.approvalAllowed,true);assert.deepEqual(decision.schemes.map(s=>s.classification),['reduction-required','reduction-required']);assert.equal(decision.schemes.find(s=>s.type==='限量抢购').candidateReady,false);
 const selected=consent(f);assert.equal(selected.option.activityType,'限时抢购');assert.equal(selected.option.rows.find(r=>r.id==='5500000000000000103').saleFen,11200);assert.equal(targetState(f.journal,f.policy.shopId),before);assert.deepEqual(f.journal.priceTarget(f.policy.shopId,f.baseline.productId).rows,oldRows);assert.equal(f.service.priceApprovalIntent(f.baseline.productId),null);assert.equal(f.state.submits,0);assert.equal(f.journal.list(f.policy.shopId).length,0);
 assert.throws(()=>f.service.queueExactPriceApproval({...selected.args,acceptPriceAndRisk:false}),{code:'PRICE_CONSENT_REQUIRED'});assert.equal(targetState(f.journal,f.policy.shopId),before);
});
test('explicit ERO consent queues no price authority, then two actual fresh dry checks approve exactly 112 without a submit',async t=>{
 const f=fixture(t),shown=consent(f),before=targetState(f.journal,f.policy.shopId),oldReviewRows=structuredClone(shown.review.rows),queued=f.service.queueExactPriceApproval(shown.args);
 assert.equal(queued.queued,true);assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'pending');assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.state.dualReads.length,0);assert.equal(f.state.submits,0);
 f.advance(1000);await f.service.revalidateExactPriceIntent(f.baseline);assert.equal(f.state.dualReads.length,2);assert.deepEqual([...new Set(f.state.dualReads)].sort(),['限时抢购','限量抢购'].sort());
 assert.ok(f.state.readPrices.every(p=>p.prices.find(r=>r.id==='5500000000000000103').saleFen===21056),'fresh probes must enter the existing guarded prices, never the guessed lower candidate');
 const target=f.journal.priceTarget(f.policy.shopId,f.baseline.productId);assert.equal(target.type,'限时抢购');assert.equal(target.rows.find(r=>r.id==='5500000000000000103').saleFen,11200);assert.equal(target.rows.find(r=>r.id==='5500000000000000103').discount,50);assert.deepEqual(target.rows.map(r=>r.saleFen),shown.option.rows.map(r=>r.saleFen));assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'approved');assert.equal(target.approvedAt,f.now());assert.deepEqual(f.journal.priceReview(shown.review.id).rows,oldReviewRows);assert.equal(f.state.submits,0);assert.equal(f.journal.list(f.policy.shopId).length,0);
});
test('a new cap does not drift from the exact consent table and instead requests a new review',async t=>{
 const f=fixture(t),shown=consent(f),before=targetState(f.journal,f.policy.shopId);f.service.queueExactPriceApproval(shown.args);f.advance(1000);f.state.capFen=11100;
 await assert.rejects(f.service.revalidateExactPriceIntent(f.baseline),{code:'PRICE_INTENT_REVIEW_REQUIRED'});assert.equal(f.state.dualReads.length,2);assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'needs-review');assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.state.submits,0);
 const next=getDualActivityDecision(f.journal,f.policy.shopId,f.baseline.productId,f.now());assert.equal(next.schemes.find(s=>s.type==='限时抢购').candidate.rows.find(r=>r.id==='5500000000000000103').saleFen,10976);
});
test('a platform read pending retains intent and price floor, and a later real complete retry may approve',async t=>{
 const f=fixture(t),before=targetState(f.journal,f.policy.shopId);f.service.queueExactPriceApproval(consent(f).args);f.advance(1000);f.state.failTypes.add('限量抢购');
 await assert.rejects(f.service.revalidateExactPriceIntent(f.baseline),{code:'PRICE_REVALIDATION_PENDING'});assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'pending');assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.state.submits,0);
 f.state.failTypes.clear();f.advance(1000);await f.service.revalidateExactPriceIntent(f.baseline);assert.equal(f.state.dualReads.length,4);assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'approved');assert.equal(f.journal.priceTarget(f.policy.shopId,f.baseline.productId).rows.find(r=>r.id==='5500000000000000103').saleFen,11200);assert.equal(f.state.submits,0);
});
test('a fresh non-reducing timed alternative supersedes a lowering intent without granting the lower price',async t=>{
 const f=fixture(t),before=targetState(f.journal,f.policy.shopId);f.service.queueExactPriceApproval(consent(f).args);f.advance(1000);f.state.capFen=null;
 await f.service.revalidateExactPriceIntent(f.baseline);assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'superseded-by-non-reducing');assert.equal(f.state.dualReads.length,2);assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.state.submits,0);const d=getDualActivityDecision(f.journal,f.policy.shopId,f.baseline.productId,f.now());assert.equal(d.selectedType,'限时抢购');assert.equal(d.approvalAllowed,false);
});
test('cancelling while a platform draft is awaited cannot approve the intent when that read completes',async t=>{
 const f=fixture(t),before=targetState(f.journal,f.policy.shopId),queued=f.service.queueExactPriceApproval(consent(f).args),read=f.platform.priceCheck;
 let enter,release;const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});let readCount=0;
 f.platform.priceCheck=async task=>{if(++readCount===2){enter();await gate;}return read(task);};
 f.advance(1000);const pending=f.service.revalidateExactPriceIntent(f.baseline);await entered;assert.equal(readCount,2);f.service.cancelExactPriceApproval(f.baseline.productId,queued.intentId);release();await assert.rejects(pending,{code:'PRICE_INTENT_CANCELLED'});assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'cancelled');assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.state.submits,0);
});
for(const peer of [false,true])test('a selected '+(peer?'peer':'same-type')+' option is rebound to its own fresh review and exact activity',async t=>{
 const f=fixture(t,{ero:false}),shown=consent(f,{peer}),before=targetState(f.journal,f.policy.shopId),queued=f.service.queueExactPriceApproval(shown.args);assert.equal(queued.queued,true);assert.equal(targetState(f.journal,f.policy.shopId),before);f.advance(1000);
 await f.service.revalidateExactPriceIntent(f.baseline);const target=f.journal.priceTarget(f.policy.shopId,f.baseline.productId);assert.equal(target.type,shown.option.activityType);assert.deepEqual(target.rows.map(r=>[r.id,r.discount,r.saleFen]),shown.option.rows.map(r=>[r.id,r.discount,r.saleFen]));assert.equal(f.state.dualReads.length,2);assert.equal(f.service.priceApprovalIntent(f.baseline.productId).state,'approved');assert.equal(f.state.submits,0);
});
function secondProposal(f){
 const b={...structuredClone(f.baseline),productId:'3500000000000000002',name:'第二个等待价格确认的商品'};f.journal.remember(b,f.now());const plan=planOriginalRestore(b,{...structuredClone(b),complete:true,observedAt:f.now()},f.policy,f.now()),grant=activeDualActivityCareGrant(f.journal,f.policy.shopId,f.now());
 const probes=['限时抢购','限量抢购'].map(type=>{const task={id:randomUUID(),title:'second-evidence-refresh',shopId:plan.shopId,phase:'queued',plans:[dualProbePlan(plan,type,grant.choices)],submitAttempts:0,riskAttempts:0,dualProbe:{grantId:grant.id,choices:structuredClone(grant.choices),plan:structuredClone(plan)}};return{type,task,observation:dualDraftObservation(task,{now:f.now(),capFen:5800})};});f.journal.recordDualActivityDecision(makeDualActivityDecision({plan,probes,now:f.now()}),f.now());
}
test('the real 30-second evidence timer queues bounded fresh reads without creating an intent or price authority',t=>{
 const f=fixture(t,{ero:false});secondProposal(f);const before=targetState(f.journal,f.policy.shopId);let wakes=0;f.service.immediateEnabled=true;f.service.tick=async()=>{};f.service.wakeImmediate=()=>{wakes++;};
 t.mock.timers.enable({apis:['setInterval']});f.service.start();assert.ok(f.service.priceEvidenceTimer);f.advance(80000);t.mock.timers.tick(30000);let items=recoveryRequests(f.journal,f.policy.shopId).items;assert.equal(items.length,1);assert.equal(items[0].requestReason,'price-evidence-refresh');assert.equal(wakes,1);
 f.advance(30000);t.mock.timers.tick(30000);items=recoveryRequests(f.journal,f.policy.shopId).items;assert.equal(items.length,2);assert.equal(new Set(items.map(r=>r.productId)).size,2);assert.equal(wakes,2);
 const queue=recoveryRequests(f.journal,f.policy.shopId);queue.items=[];f.journal.putSettings('priority-recovery:'+f.policy.shopId,queue);assert.equal(f.service.queuePriceEvidenceRefresh(),0,'each product must keep its own 60-second refresh limit');f.advance(30000);assert.equal(f.service.queuePriceEvidenceRefresh(),1);assert.equal(recoveryRequests(f.journal,f.policy.shopId).items.length,1);
 assert.equal(targetState(f.journal,f.policy.shopId),before);assert.equal(f.service.priceApprovalIntent(f.baseline.productId),null);assert.equal(f.state.dualReads.length,0);assert.equal(f.state.submits,0);assert.equal(f.journal.list(f.policy.shopId).length,0);f.service.stop();assert.equal(f.service.priceEvidenceTimer,null);
});
