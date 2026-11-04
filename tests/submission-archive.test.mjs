import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint,planOriginalRestore,proveDraft,saleFen} from '../src/policy.mjs';
import {makeSubmissionInvestigation,submissionQueryScope,submissionTaskFingerprint} from '../src/submission-investigation.mjs';
import {consentForTasks,makeRetirement,successorLossKey,validateRetiredTask} from '../src/unresolved-recovery.mjs';

function fixture({limited=false}={}){
 const j=new Journal(':memory:'),now=Date.now(),at=now-16*3600000,shopId='900001',productId='300001',type=limited?'限量抢购':'限时抢购';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400001',type,rules:{noLimit:!limited,noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(limited?{autoRenew:true}:{})},
  ...(limited?{durationMs:7*86400000,activityLimit:1000}:{}),observedAt:at,skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60},{id:'500002',name:'规格乙',baseFen:12000,discount:60}]};j.remember(baseline,at);
 const planAt=time=>planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:time,skus:baseline.skus},{shopId,originalRiskAllowed:true},time);
 const originalPlan=planAt(at);let task=j.enqueue(shopId,[originalPlan],{complete:true,observedAt:at,lossKey:'same-platform-loss'},at);
 const observation=(t,time)=>({kind:'draft',shopId,title:t.title,type:t.plans[0].type,rules:t.plans[0].rules,complete:true,observedAt:time,startAt:time,endAt:time+(t.plans[0].durationMs||48*3600000),
  rows:t.plans.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),warnings:[],dialogs:[],...(t.plans[0].type==='限量抢购'?{productLimits:t.plans.map(p=>({productId:p.productId,activityLimit:p.activityLimit}))}:{})});
 j.transition(task.id,'queued','prepared',{},at);j.beginSubmit(task.id,proveDraft(task,observation(task,at),at),at);j.transition(task.id,'submitting','unknown',{reason:'平台主提交后结果未知'},at+1);task=j.get(task.id);
 const context={runtimeId:'local-archive-fixture',now,histories:j.histories(shopId),actorExit:{source:'owned-process-tree-exit',shopId,complete:true,taskFingerprint:submissionTaskFingerprint(task),observedAt:now-10000,allExited:true,currentDraftAbsent:true,processIds:[101,102]},quantityProofs:[]};
 const consent=consentForTasks([task],{shopId,runtimeId:context.runtimeId,authorizationRef:'user-acknowledged-current-old-unknown',acceptHistoricalUnknown:true,acceptOneNewLifecycle:true,noPriceReductions:true,noQuotaIncrease:true,at:now-100,expiresAt:now+3600000},now);
 const listing=(query,time,campaigns=[])=>{const f={source:'rendered-list-query-controls',observedAt:time,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],selectedFilters:[],selectedTabs:[],dateControls:[{placeholder:'开始日期',value:''},{placeholder:'结束日期',value:''}]},queryScope=submissionQueryScope({shopId,query,before:f,after:structuredClone(f),pages:1});queryScope.activityTypes=['限时抢购','限量抢购'];return{complete:true,shopId,observedAt:time,query,campaigns,queryScope};};
 const raw=time=>{const c={id:baseline.campaignId,name:'原历史来源',type,status:'已失效',startAt:at-7*86400000,endAt:at-1000,risk:true},detail={complete:true,observedAt:time+10,rules:baseline.rules,products:[{productId,skus:originalPlan.skus,removalConfirmed:true,removalRiskConfirmed:true,removalAmbiguous:false,soldOut:false,...(limited?{activityLimit:1000}:{})}]};
  return makeSubmissionInvestigation(task,{startedAt:time,finishedAt:time+20,titleListing:listing({productId:null,title:task.title,status:null},time),productQueries:[null,'进行中','未开始'].map(status=>({productId,status,error:null,listing:listing({productId,title:null,status},time,limited&&status===null?[c]:[])})),
   details:limited?[{campaignId:c.id,shopId,campaign:c,detail}]:[],referenceQueries:limited?[{productId,historicalFingerprint:originalPlan.historicalFingerprint,sourceCampaignId:c.id,lookup:'present-in-product-query',hintOnly:true}]:[]});};
 const raws=[raw(now-4000),raw(now-2000)];if(limited){const d=raws[1].details[0];context.quantityProofs.push({source:'live-platform-limited-quota',complete:true,shopId,productId,campaignId:d.campaignId,historicalFingerprint:originalPlan.historicalFingerprint,observedAt:d.detail.observedAt,soldOut:false,activityLimit:1000,evidenceFingerprint:fingerprint({campaign:d.campaign,detail:d.detail})});}
 const retirement=makeRetirement(task,raws,consent,context);assert.equal(retirement.allowed,true,JSON.stringify(retirement));
 const originalRow={...j.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id)};
 const retire=()=>j.retireUnresolved(task.id,retirement,now),enqueue=(plan=planAt(now),lossKey='same-platform-loss')=>j.enqueue(shopId,[plan],{complete:true,observedAt:now,lossKey,unresolvedRecoveryClosureId:retirement.closure.id},now);
 return{j,now,at,shopId,productId,baseline,originalPlan,task,originalRow,retirement,retire,enqueue,planAt,observation};
}
const run=(name,fn,options)=>test(name,async()=>{const f=fixture(options);try{await fn(f);}finally{f.j.close();}});

run('retirement atomically preserves the complete SQL row and original unknown financial material',f=>{
 const tables=()=>JSON.stringify(Object.fromEntries(['baselines','price_reviews','price_targets','product_checks'].map(t=>[t,f.j.db.prepare('SELECT * FROM '+t).all()]))),before=tables(),r=f.retire(),current=f.j.get(f.task.id);
 assert.deepEqual(r.originalRow,f.originalRow);assert.deepEqual(r.original,f.task);assert.equal(r.closure.historicalOutcome,'unknown');assert.equal(r.closure.success,false);assert.equal(r.successor,null);assert.equal(current.phase,'blocked');assert.match(current.reason,/历史提交结果仍未知.*非恢复成功/);assert.equal(validateRetiredTask(f.task,current,r.closure).allowed,true);
 assert.equal(current.submitAttempts,1);assert.equal(current.riskAttempts,0);assert.equal(current.draftProof.fingerprint,f.task.draftProof.fingerprint);assert.equal(tables(),before);
 assert.deepEqual(f.j.unresolvedRecovery(f.task.id),r);assert.equal(f.j.unresolvedRecoveries(f.shopId).length,1);assert.equal(f.j.unresolvedRecoveries('900002').length,0);
});
run('duplicate retirement is idempotent without another archive or another retirement event',f=>{
 const r=f.retire(),events=f.j.db.prepare('SELECT COUNT(*) n FROM events').get().n,again=f.j.retireUnresolved(f.task.id,f.retirement,f.now+1);assert.deepEqual(again,r);assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM submission_archives').get().n,1);assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM events').get().n,events);
});
run('archive payloads cannot be updated or deleted through SQLite',f=>{
 f.retire();assert.throws(()=>f.j.db.prepare('UPDATE submission_archives SET original_row=?').run('{}'),/immutable/);assert.throws(()=>f.j.db.exec('DELETE FROM submission_archives'),/immutable/);assert.deepEqual(f.j.unresolvedRecovery(f.task.id).originalRow,f.originalRow);
});
for(const change of ['reason','counter','proof','plan'])run('full-task CAS rejects a changed original '+change,f=>{
 const row=f.j.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id),body=JSON.parse(row.body);if(change==='reason')body.reason='changed';if(change==='counter')body.riskAttempts=1;if(change==='proof')body.draftProof.materialFingerprint='0'.repeat(64);if(change==='plan')body.plans[0].skus[0].saleFen--;
 f.j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),f.task.id);assert.throws(f.retire,{code:'UNRESOLVED_ARCHIVE'});assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM submission_archives').get().n,0);assert.equal(f.j.get(f.task.id).phase,'unknown');
});
run('an update failure rolls back both the archive insert and the task transition',f=>{
 f.j.db.exec("CREATE TRIGGER simulated_task_failure BEFORE UPDATE ON tasks WHEN NEW.phase='blocked' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");assert.throws(f.retire,/simulated write failure/);assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM submission_archives').get().n,0);assert.deepEqual({...f.j.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id)},f.originalRow);
});
run('an explicit new lifecycle has a deterministic different dedupe from the old already-submitted task',f=>{
 f.retire();const next=f.enqueue();assert.notEqual(next.id,f.task.id);assert.equal(next.submitAttempts,0);assert.equal(next.riskAttempts,0);assert.equal(next.lossEvidence.unresolvedRecoveryClosureId,f.retirement.closure.id);assert.equal(next.lossEvidence.lossKey,successorLossKey(f.retirement.closure,'same-platform-loss'));
 assert.equal(f.enqueue().id,next.id);assert.equal(f.enqueue(f.planAt(f.now+1),'fresh-other-platform-key').id,next.id);assert.equal(f.j.unresolvedRecovery(f.task.id).successor.taskId,next.id);assert.equal(f.j.list(f.shopId).length,2);
});
run('a missing explicit closure cannot fall through to legacy dedupe or a changed history',f=>{
 f.retire();assert.throws(()=>f.j.enqueue(f.shopId,[f.planAt(f.now)],{complete:true,observedAt:f.now,lossKey:'same-platform-loss'},f.now),{code:'UNRESOLVED_CLOSURE_REQUIRED'});
 const plan=f.planAt(f.now);plan.historicalFingerprint='a'.repeat(64);assert.throws(()=>f.j.enqueue(f.shopId,[plan],{complete:true,observedAt:f.now,lossKey:'other-history'},f.now),{code:'UNRESOLVED_CLOSURE_REQUIRED'});assert.equal(f.j.list(f.shopId).length,1);
});
run('the archived original can never be requeued or have its old financial boundary repeated',f=>{
 f.retire();assert.throws(()=>f.j.transition(f.task.id,'blocked','queued',{submitAttempts:0,retryAfter:f.now},f.now),{code:'UNRESOLVED_ORIGINAL_RETIRED'});assert.equal(f.j.requestFreshUnsubmittedRecheck(f.task.id,f.now+1,f.now+2),false);assert.throws(()=>f.j.beginSubmit(f.task.id,f.task.draftProof,f.now));assert.equal(f.j.get(f.task.id).submitAttempts,1);
});
run('one successor main-submit use is durable and an unknown successor cannot generate another task',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);const proof=proveDraft(next,f.observation(next,f.now),f.now);f.j.beginSubmit(next.id,proof,f.now);
 assert.equal(f.j.unresolvedRecovery(f.task.id).successor.submittedAt,f.now);f.j.transition(next.id,'submitting','unknown',{reason:'new response is also unknown'},f.now+1);assert.equal(f.enqueue(f.planAt(f.now+2),'third-loss').id,next.id);assert.equal(f.j.list(f.shopId).length,2);assert.throws(()=>f.j.beginSubmit(next.id,proof,f.now+1));
 assert.throws(()=>f.j.retireUnresolved(next.id,f.retirement,f.now+2),{code:'UNRESOLVED_SUCCESSOR_SUBMITTED'});assert.equal(f.j.get(next.id).submitAttempts,1);assert.equal(f.j.get(f.task.id).submitAttempts,1);
});
run('a zero-submit blocked successor is retained, never replaced by a second task',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','blocked',{reason:'fresh draft requires another read',retryAfter:f.now},f.now);assert.equal(f.enqueue(f.planAt(f.now+1),'changed-loss').id,next.id);assert.equal(f.j.list(f.shopId).length,2);
});
run('a normal later loss after the submitted successor was verified does not inherit the one-cycle limit',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);f.j.beginSubmit(next.id,proveDraft(next,f.observation(next,f.now),f.now),f.now);f.j.transition(next.id,'submitting','verifying',{},f.now+1);f.j.transition(next.id,'verifying','verified',{receipt:{campaignId:'400002',verifiedAt:f.now+2}},f.now+2);
 const normal=f.j.enqueue(f.shopId,[f.planAt(f.now+3)],{complete:true,observedAt:f.now+3,lossKey:'later-genuine-new-loss'},f.now+3);assert.notEqual(normal.id,next.id);assert.equal(normal.lossEvidence.unresolvedRecoveryClosureId,undefined);assert.equal(normal.submitAttempts,0);
});
for(const change of ['source','sku','price','type','flag'])run('successor admission rejects scope drift: '+change,f=>{
 f.retire();const plan=f.planAt(f.now);if(change==='source')plan.historicalFingerprint='a'.repeat(64);if(change==='sku')plan.skus.pop();if(change==='price')for(const s of plan.skus){s.discount=50;s.saleFen=saleFen(s.baseFen,s.discount);}if(change==='type')plan.type='限量抢购';
 if(change==='flag')assert.throws(()=>f.j.enqueue(f.shopId,[plan],{complete:true,observedAt:f.now,lossKey:'loss',unresolvedRecoveryClosureId:'f'.repeat(64)},f.now));else assert.throws(()=>f.enqueue(plan));assert.equal(f.j.list(f.shopId).length,1);
});
run('the submit boundary rejects mutated price, missing scope or another already mapped successor',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);const row=f.j.db.prepare('SELECT body FROM tasks WHERE id=?').get(next.id),body=JSON.parse(row.body);delete body.lossEvidence.unresolvedRecoveryClosureId;f.j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),next.id);
 const changed=f.j.get(next.id);assert.throws(()=>f.j.beginSubmit(next.id,proveDraft(changed,f.observation(changed,f.now),f.now),f.now),{code:'UNRESOLVED_CYCLE'});assert.equal(f.j.get(next.id).submitAttempts,0);assert.equal(f.j.unresolvedRecovery(f.task.id).successor.submittedAt,null);
});
run('the actual limited quota remains a hard bound at enqueue and submit',f=>{
 f.retire();const larger=f.planAt(f.now);larger.activityLimit=1001;assert.throws(()=>f.enqueue(larger));const timed=f.planAt(f.now);timed.type='限时抢购';assert.throws(()=>f.enqueue(timed));
 const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);const row=f.j.db.prepare('SELECT body FROM tasks WHERE id=?').get(next.id),body=JSON.parse(row.body);body.plans[0].activityLimit=1001;f.j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),next.id);const changed=f.j.get(next.id);assert.throws(()=>f.j.beginSubmit(next.id,proveDraft(changed,f.observation(changed,f.now),f.now),f.now));assert.equal(f.j.get(next.id).submitAttempts,0);
},{limited:true});
function approvedTarget(f,{automatic=false,approvedAt=f.now+1}={}){
 const plan=f.planAt(f.now),rows=plan.skus.map(s=>({...s,previousFen:s.saleFen,previousDiscount:s.discount,discount:50,saleFen:saleFen(s.baseFen,50)}));
 const review={id:'manual-price-approval',key:'manual-key',shopId:f.shopId,productId:f.productId,status:'approved',type:plan.type,historicalFingerprint:plan.historicalFingerprint,approvedAt,rows,approvalKind:automatic?'automatic-price-increase':'manual-human',
  consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true},...(automatic?{automaticConsent:{grantId:'not-human'}}:{})};
 f.j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(review.id,f.shopId,f.productId,'approved',JSON.stringify(review),approvedAt);f.j.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(f.shopId,f.productId,review.id);
 plan.priceApprovalId=review.id;plan.priceApprovalKey=review.key;plan.skus=rows.map(({previousFen,previousDiscount,...s})=>s);return plan;
}
run('a later explicit human price approval can lower the old floor only for its exact current target',f=>{
 f.retire();const plan=approvedTarget(f),next=f.enqueue(plan);f.j.transition(next.id,'queued','prepared',{},f.now+2);const proof=proveDraft(next,f.observation(next,f.now+2),f.now+2);f.j.beginSubmit(next.id,proof,f.now+2);assert.equal(f.j.get(next.id).submitAttempts,1);assert.equal(f.j.get(next.id).plans[0].skus[0].saleFen,5000);
});
for(const change of ['automatic','before-incident'])run('a lower target cannot borrow stale or automatic consent: '+change,f=>{
 f.retire();const plan=approvedTarget(f,{automatic:change==='automatic',approvedAt:change==='before-incident'?f.now-1:f.now+1});assert.throws(()=>f.enqueue(plan),{code:'UNRESOLVED_PRICE'});assert.equal(f.j.list(f.shopId).length,1);
});
run('current target changes between prepare and native financial boundary cannot use the previous floor',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);approvedTarget(f);assert.throws(()=>f.j.beginSubmit(next.id,proveDraft(next,f.observation(next,f.now+2),f.now+2),f.now+2));assert.equal(f.j.get(next.id).submitAttempts,0);assert.equal(f.j.unresolvedRecovery(f.task.id).successor.submittedAt,null);
});
run('the one-lifecycle consent expiry remains a hard guard at the real submit boundary',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);const expired=f.retirement.closure.consentExpiresAt;
 assert.throws(()=>f.j.beginSubmit(next.id,proveDraft(next,f.observation(next,expired),expired),expired),{code:'UNRESOLVED_CONSENT_EXPIRED'});assert.equal(f.j.get(next.id).submitAttempts,0);assert.equal(f.j.unresolvedRecovery(f.task.id).successor.submittedAt,null);
});
run('a failed task submit commit rolls back the same-transaction successor allowance consumption',f=>{
 f.retire();const next=f.enqueue();f.j.transition(next.id,'queued','prepared',{},f.now);f.j.db.exec("CREATE TRIGGER fail_new_submit BEFORE UPDATE ON tasks WHEN NEW.phase='submitting' BEGIN SELECT RAISE(ABORT,'simulated submit write failure'); END");
 assert.throws(()=>f.j.beginSubmit(next.id,proveDraft(next,f.observation(next,f.now),f.now),f.now),/simulated submit write failure/);assert.equal(f.j.get(next.id).phase,'prepared');assert.equal(f.j.get(next.id).submitAttempts,0);assert.equal(f.j.unresolvedRecovery(f.task.id).successor.submittedAt,null);
});
run('an already-proven non-financial retirement records the actual later save time within ten minutes',f=>{
 const savedAt=f.now+5*60000,r=f.j.retireUnresolved(f.task.id,f.retirement,savedAt);assert.equal(r.closure.at,f.now);assert.equal(r.retiredAt,savedAt);assert.equal(f.j.get(f.task.id).updatedAt,savedAt);assert.equal(r.closure.authorizesSubmit,false);assert.equal(r.closure.historicalOutcome,'unknown');
});
run('an older retirement decision cannot write after ten minutes even when the original row is unchanged',f=>{
 assert.throws(()=>f.j.retireUnresolved(f.task.id,f.retirement,f.now+600001),{code:'UNRESOLVED_ARCHIVE_CHANGED'});assert.equal(f.j.unresolvedRecovery(f.task.id),null);assert.equal(f.j.get(f.task.id).phase,'unknown');
});
