import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {planOriginalRestore,fingerprint,saleFen,proveDraft} from '../src/policy.mjs';
import {setCareRecoveryPolicy} from '../src/care-recovery-policy.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';
import {dualProbePlan,makeDualActivityDecision,getDualActivityDecision,setDualActivityCarePolicy,activeDualActivityCareGrant} from '../src/dual-activity-recovery.mjs';

const timed='限时抢购',limited='限量抢购';
function fixture({dual=true}={}){
 const journal=new Journal(':memory:'),now=Date.now(),accounts=new AccountRegistry(journal);
 accounts.register({shopId:'900001'},'signin-dual-acceptance');accounts.authorizeOriginal('900001');
 if(dual)setDualActivityCarePolicy(journal,'900001',{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},now);
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',name:'双方案独立验收商品',campaignId:'400001',type:timed,durationMs:48*3600000,
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'滤芯甲',baseFen:10000,discount:50},{id:'500002',name:'滤芯乙',baseFen:20000,discount:50}]};
 journal.remember(baseline,now);
 // This is the actual native create-form precheck shape: no campaign ID and
 // no visible SKU IDs. Only unique names plus unchanged bases can map it.
 const current={shopId:baseline.shopId,productId:baseline.productId,complete:true,observedAt:now,offShelf:false,
  skus:baseline.skus.map(s=>({id:null,idSource:'unavailable-in-create-form',name:s.name,baseFen:s.baseFen}))};
 const policy={shopId:baseline.shopId,excludedProductIds:[],originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true};
 const plan=planOriginalRestore(baseline,current,policy,now);
 return{journal,now,baseline,current,policy,plan};
}
function nativeProbe(plan,type,{at=plan.observedAt,errors={},warnings=[]}={}){
 const target=dualProbePlan(plan,type),task={id:'native-probe-'+type,title:'双方案独立草稿-'+type,shopId:plan.shopId,phase:'queued',plans:[target],submitAttempts:0,riskAttempts:0};
 const rows=target.skus.map(s=>({...s,productId:target.productId,errors:errors[s.id]||[]}));
 const observation={source:'live-platform-draft',kind:'draft',shopId:plan.shopId,title:task.title,complete:true,observedAt:at,type,rules:structuredClone(target.rules),startAt:at,endAt:at+target.durationMs,
  rows,warnings:[...new Set([...rows.flatMap(r=>r.errors),...warnings])],dialogs:[],...(type===limited?{productLimits:[{productId:plan.productId,activityLimit:target.activityLimit}]}:{})};
 return{type,task,observation};
}
const cap=(plan,type,fen)=>nativeProbe(plan,type,{errors:{'500001':['活动价不得高于'+fen/100+'元']}});
const floor=(plan,type,fen)=>nativeProbe(plan,type,{errors:{'500001':['活动价不得低于'+fen/100+'元']}});
const classes=decision=>Object.fromEntries(decision.schemes.map(s=>[s.type,s.classification]));

test('independently valid timed price wins over a limited reduction and accepts real null-ID prechecks',()=>{
 const f=fixture();try{
  assert.equal('campaignId' in f.current,false);assert.ok(f.current.skus.every(s=>s.id===null));assert.deepEqual(f.plan.skus.map(s=>s.mapping),['unique-name-and-base','unique-name-and-base']);
  const decision=makeDualActivityDecision({plan:f.plan,probes:[nativeProbe(f.plan,timed),cap(f.plan,limited,4800)],now:f.now});
  assert.deepEqual(classes(decision),{[timed]:'non-reducing',[limited]:'reduction-required'});assert.equal(decision.selectedType,timed);assert.equal(decision.approvalAllowed,false);
  assert.deepEqual(decision.schemes[0].candidate.rows.map(r=>r.saleFen),[5000,10000]);assert.equal(f.journal.priceTarget('900001','300001'),null,'classification alone never approves prices');
 }finally{f.journal.close();}
});

test('the opposite type can raise only its constrained SKU without borrowing the first type cap',()=>{
 const f=fixture();try{
  const decision=makeDualActivityDecision({plan:f.plan,probes:[cap(f.plan,timed,4800),floor(f.plan,limited,5500)],now:f.now});
  assert.deepEqual(classes(decision),{[timed]:'reduction-required',[limited]:'non-reducing'});assert.equal(decision.selectedType,limited);assert.equal(decision.approvalAllowed,false);
  assert.deepEqual(decision.schemes[1].candidate.rows.map(r=>r.saleFen),[5500,10000]);assert.equal(decision.schemes[0].candidate.rows[0].saleFen,4800);
 }finally{f.journal.close();}
});

test('only two independently proven reductions expose confirmation and keep distinct exact caps',()=>{
 const f=fixture();try{
  const decision=makeDualActivityDecision({plan:f.plan,probes:[cap(f.plan,timed,4800),cap(f.plan,limited,4500)],now:f.now});
  assert.deepEqual(classes(decision),{[timed]:'reduction-required',[limited]:'reduction-required'});assert.equal(decision.approvalAllowed,true);assert.equal(decision.selectedType,null);
  assert.deepEqual(decision.schemes.map(s=>s.candidate.rows[0].saleFen),[4800,4500]);assert.deepEqual(decision.schemes.map(s=>s.candidate.rows[0].bounds.maxFen),[4800,4500]);
  const saved=f.journal.recordDualActivityDecision(decision,f.now),read=getDualActivityDecision(f.journal,'900001','300001',f.now);
  assert.equal(saved.valid,true);assert.equal(read.approvalAllowed,true);assert.ok(read.schemes.every(s=>s.reviewId));assert.equal(read.selectedReviewId,null);assert.equal(f.journal.priceTarget('900001','300001'),null);
 }finally{f.journal.close();}
});

for(const other of ['missing','read-failed','unavailable'])test('one proven reduction plus '+other+' remains automatic verification, not a human price decision',()=>{
 const f=fixture();try{
  const second=other==='missing'?[]:other==='read-failed'?[{type:limited,error:{code:'LOAD_TIMEOUT',message:'限量草稿未完整加载'}}]:[floor(f.plan,limited,9600)];
  const decision=makeDualActivityDecision({plan:f.plan,probes:[cap(f.plan,timed,4800),...second],now:f.now});
  assert.equal(decision.schemes[0].classification,'reduction-required');assert.equal(decision.schemes[1].classification,other==='unavailable'?'unavailable':'pending');assert.equal(decision.approvalAllowed,false);assert.equal(decision.selectedType,null);
 }finally{f.journal.close();}
});

for(const invalid of ['expired','wrong-type','unbound-warning'])test('a '+invalid+' probe cannot turn a single valid rejection into two proved reductions',()=>{
 const f=fixture();try{
  const second=cap(f.plan,limited,4500);
  if(invalid==='expired')second.observation.observedAt=f.now-120001;
  if(invalid==='wrong-type')second.observation.type=timed;
  if(invalid==='unbound-warning')second.observation.warnings.push('平台其他资格校验尚未完成');
  const decision=makeDualActivityDecision({plan:f.plan,probes:[cap(f.plan,timed,4800),second],now:f.now});
  assert.equal(decision.schemes[1].classification,'pending');assert.equal(decision.approvalAllowed,false);assert.equal(decision.selectedType,null);
 }finally{f.journal.close();}
});

test('non-decreasing means relative to the current approved target, never the older historical price',()=>{
 const f=fixture();try{
  const prior=f.journal.savePriceReview({shopId:'900001',productId:'300001',name:f.baseline.name,taskId:null,key:'prior-human-exact-price',type:f.plan.type,rules:structuredClone(f.plan.rules),historicalFingerprint:f.plan.historicalFingerprint,previousApprovalId:null,createdAt:f.now,expiresAt:f.now+120000,
   rows:f.plan.skus.map(s=>({id:s.id,name:s.name,baseFen:s.baseFen,historicalDiscount:s.discount,previousDiscount:s.discount,previousFen:s.saleFen,discount:70,saleFen:saleFen(s.baseFen,70),bounds:{},evidence:[]}))},f.now);
  // Seed a previously approved v59 target; the v60 human endpoint correctly
  // refuses creating a new arbitrary higher target without a dual decision.
  const approved={...prior,status:'approved',approvedAt:f.now,consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true}};
  f.journal.db.prepare('UPDATE price_reviews SET state=?,body=? WHERE id=?').run('approved',JSON.stringify(approved),approved.id);f.journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run('900001','300001',approved.id);
  const source=applyPriceTarget(f.plan,approved);
  const decision=makeDualActivityDecision({plan:source,probes:[cap(source,timed,6000),cap(source,limited,6500)],now:f.now});
  assert.equal(decision.approvalAllowed,true);assert.equal(decision.selectedType,null);assert.deepEqual(decision.schemes.map(s=>s.classification),['reduction-required','reduction-required']);
  assert.ok(decision.schemes.every(s=>s.candidate.rows[0].historicalDiscount===50&&s.candidate.rows[0].previousFen===7000));
  assert.deepEqual(decision.schemes.map(s=>s.candidate.rows[0].saleFen),[6000,6500]);
 }finally{f.journal.close();}
});

test('a persisted decision expires and cannot bypass an unresolved submission or a changed target',()=>{
 const f=fixture();try{
  const decision=makeDualActivityDecision({plan:f.plan,probes:[cap(f.plan,timed,4800),cap(f.plan,limited,4500)],now:f.now});f.journal.recordDualActivityDecision(decision,f.now);
  const expired=getDualActivityDecision(f.journal,'900001','300001',f.now+120001);assert.equal(expired.valid,true);assert.equal(expired.requiresRevalidation,true);assert.equal(expired.approvalReady,false);assert.equal(expired.approvalAllowed,false);assert.equal(expired.selectedType,null);assert.ok(expired.schemes.every(s=>s.classification==='reduction-required'));
  const task=f.journal.enqueue('900001',[f.plan],{complete:true,observedAt:f.now,active:false,lossKey:'unknown-lock'},f.now),body=f.journal.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id);
  f.journal.db.prepare('UPDATE tasks SET phase=?,body=? WHERE id=?').run('unknown',JSON.stringify({...JSON.parse(body.body),submitAttempts:1,riskAttempts:0}),task.id);
  const locked=getDualActivityDecision(f.journal,'900001','300001',f.now);assert.equal(locked.valid,false);assert.equal(locked.approvalAllowed,false);assert.throws(()=>f.journal.approveDualActivityDecision('900001','300001',decision.pairKey,f.now));assert.equal(f.journal.get(task.id).submitAttempts,1);
  f.journal.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run('blocked',task.id);
  const newer=f.journal.priceReviews('900001')[0];f.journal.decidePriceReview('900001',newer.id,newer.key,'approve',{acceptPriceAndRisk:true,confirmedSkuIds:newer.rows.map(r=>r.id),historicalFingerprint:f.plan.historicalFingerprint},f.now);
  const changed=getDualActivityDecision(f.journal,'900001','300001',f.now);assert.equal(changed.valid,false);assert.equal(changed.approvalAllowed,false);assert.match(changed.blockedReason,/目标已变化/);
 }finally{f.journal.close();}
});

test('the old same-type care grant never silently authorizes automatic switching',()=>{
 const f=fixture({dual:false});try{
  setCareRecoveryPolicy(f.journal,'900001',{enabled:true,acceptNonReducingRecovery:true},f.now);assert.equal(activeDualActivityCareGrant(f.journal,'900001',f.now),null);
  const decision=makeDualActivityDecision({plan:f.plan,probes:[nativeProbe(f.plan,timed),cap(f.plan,limited,4500)],now:f.now});
  assert.throws(()=>f.journal.recordDualActivityDecision(decision,f.now),{code:'DUAL_ACTIVITY_CONSENT_REQUIRED'});assert.equal(f.journal.priceTarget('900001','300001'),null);
 }finally{f.journal.close();}
});
