import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {createApp} from '../src/server.mjs';
import {proveDraft} from '../src/policy.mjs';
import {submissionQueryScope,makeSubmissionInvestigation,adjudicateSubmissionInvestigation,submissionInvestigationKey} from '../src/submission-investigation.mjs';
import {claimVerification,finishVerification,verificationState} from '../src/verification-schedule.mjs';
import {recoveryRequests} from '../src/recovery-requests.mjs';
import {getDualActivityDecision,dualPriceApprovalReady} from '../src/dual-activity-recovery.mjs';
import {recoveryWorkspaceApp} from './helpers/recovery-workspace-app.mjs';
import {unresolvedDualFixture} from './helpers/unresolved-dual-fixture.mjs';

const material=journal=>JSON.stringify(Object.fromEntries(['tasks','baselines','price_reviews','price_targets','product_checks'].map(table=>[table,journal.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])));
function addUnknown(x,phase='unknown'){
 const at=Date.now(),task=x.journal.enqueue(x.plan.shopId,[x.plan],{complete:true,observedAt:at,lossKey:'workspace-original-unresolved-'+phase},at);
 const source=x.probes.find(p=>p.type===x.plan.type).observation,observation={...structuredClone(source),title:task.title,observedAt:at,rows:source.rows.map(r=>({...structuredClone(r),errors:[]})),warnings:[],dialogs:[]};
 x.journal.transition(task.id,'queued','prepared',{},at);x.journal.beginSubmit(task.id,proveDraft(task,observation,at),at);
 if(phase!=='submitting')x.journal.transition(task.id,'submitting','unknown',{reason:'原提交结果尚未核实'},at);
 if(phase==='verifying')x.journal.transition(task.id,'unknown','verifying',{},at);
 return x.journal.get(task.id);
}
function notFound(task,{reason=null,at=Date.now()}={}){
 const listing=query=>{const f={source:'rendered-list-query-controls',observedAt:at,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],dateControls:[],selectedFilters:[],selectedTabs:[]};return{complete:true,shopId:task.shopId,observedAt:at,query,campaigns:[],queryScope:submissionQueryScope({shopId:task.shopId,query,before:f,after:structuredClone(f),pages:1})};};
 const raw=makeSubmissionInvestigation(task,{startedAt:at,finishedAt:at,titleListing:listing({productId:null,title:task.title,status:null}),productQueries:task.plans.flatMap(p=>[null,'进行中','未开始'].map(status=>({productId:p.productId,status,error:null,listing:listing({productId:p.productId,title:null,status})}))),details:[]});
 raw.assessment=adjudicateSubmissionInvestigation(task,raw,{now:at});if(reason)raw.assessment.reason=reason;return raw;
}

for(const phase of ['unknown','submitting','verifying'])test('an unresolved '+phase+' remains an automatic diagnostic item and never becomes a success or price approval',async()=>{
 const x=await recoveryWorkspaceApp();try{
  const task=addUnknown(x,phase),raw=notFound(task);assert.equal(raw.assessment.classification,'not-found');assert.equal(raw.assessment.mayCloseUnknown,false);
  x.journal.putSettings(submissionInvestigationKey(task.shopId,task.id),raw);const before=material(x.journal);
  for(let i=0;i<2;i++){
   const list=await x.get('recovery-workspace?scope=automatic'),confirm=await x.get('recovery-workspace?scope=confirm'),status=await x.get('status');
   assert.equal(list.total,1);assert.equal(confirm.total,0);assert.equal(status.recoveryWorkspaceCounts.confirm,0);assert.equal(status.priceReviewsPending,0);
   const row=list.records[0];assert.equal(row.productId,x.plan.productId);assert.equal(row.category,'verification');assert.equal(row.verificationState,phase);assert.equal(row.approvalAllowed,false);assert.equal(row.canRecheck,phase==='unknown');assert.equal(row.summary,raw.assessment.reason);
   assert.doesNotMatch(row.summary,/恢复成功|已回读完成|允许重复提交/);assert.equal(status.unknown,1);assert.equal(status.verified,0);
   const displayed=status.tasks.find(t=>t.id===task.id);assert.equal(displayed.phase,phase);assert.equal(displayed.investigation.classification,'not-found');assert.equal(displayed.investigation.reason,raw.assessment.reason);assert.equal(displayed.receipt,null);
   const item=await x.get('price-reviews/item?productId='+x.plan.productId);assert.equal(item.approvalAllowed,false);assert.equal(item.blocked,true);assert.equal(item.canRecalculate,false);
  }
  assert.equal(material(x.journal),before);assert.equal(x.state.submits,0);assert.equal(x.journal.priceTarget(task.shopId,x.plan.productId),null);
 }finally{await x.close();}
});

test('the latest complete investigation is shown while the old task and exact price records stay read-only',async()=>{
 const x=await recoveryWorkspaceApp();try{
  const task=addUnknown(x),light=notFound(task,{reason:'上次简查尚未取得完整商品候选详情'}),full=notFound(task,{reason:'本次完整调查未找到原活动；历史提交结果仍未知，只继续核实。'});
  x.journal.putSettings(submissionInvestigationKey(task.shopId,task.id),light);x.journal.putSettings('submission-full-investigation:'+task.shopId+':'+task.id,full);const before=material(x.journal);
  const automatic=await x.get('recovery-workspace?scope=automatic');assert.equal(automatic.records[0].summary,full.assessment.reason);assert.equal(automatic.records[0].approvalAllowed,false);assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);
  const status=await x.get('status');assert.equal(status.tasks.find(t=>t.id===task.id).investigation.reason,full.assessment.reason);assert.equal(status.tasks.find(t=>t.id===task.id).investigation.classification,'not-found');
  assert.equal(material(x.journal),before);assert.equal(x.journal.get(task.id).phase,'unknown');assert.equal(x.journal.get(task.id).submitAttempts,1);assert.equal(x.state.submits,0);
 }finally{await x.close();}
});

test('recheck on an unknown only wakes readback and keeps every financial field and both proposals unchanged',async()=>{
 const x=await recoveryWorkspaceApp();try{
  const task=addUnknown(x),raw=notFound(task);x.journal.putSettings(submissionInvestigationKey(task.shopId,task.id),raw);
  const claim=claimVerification(x.journal,task.shopId,task,Date.now());finishVerification(x.journal,task.shopId,claim,{},Date.now());
  const nextBefore=verificationState(x.journal,task.shopId,task).nextAt,before=material(x.journal),reads=x.state.reads.length;
  const response=await x.post('recovery/request',{shopId:task.shopId,productId:x.plan.productId});assert.equal(response.status,202,await response.clone().text());
  const wake=verificationState(x.journal,task.shopId,task);assert.ok(wake.nextAt<nextBefore);assert.ok(wake.nextAt<=Date.now());
  assert.ok(recoveryRequests(x.journal,task.shopId).items.some(r=>r.productId===x.plan.productId&&r.state==='pending'));
  assert.equal(material(x.journal),before);assert.equal(x.state.reads.length,reads);assert.equal(x.state.submits,0);assert.equal(x.journal.get(task.id).phase,'unknown');assert.equal(x.journal.get(task.id).submitAttempts,1);
  assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);assert.equal(x.journal.priceTarget(task.shopId,x.plan.productId),null);
 }finally{await x.close();}
});

async function scopedApp(options={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-unresolved-workspace-')),journal=new Journal(':memory:'),f=unresolvedDualFixture(journal,options),platform={probe:async()=>({shopId:f.shopId,name:'原未知恢复隔离工作台'}),progress:{stage:'尚未连接'}};
 const service=new GuardianService({journal,platform,policy:f.policy,immediate:false}),app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
 const get=async path=>{const r=await fetch(app.url+'/api/'+path);assert.equal(r.status,200,await r.clone().text());return r.json();},post=(path,args)=>fetch(app.url+'/api/'+path,{method:'POST',headers,body:JSON.stringify(args)});
 await post('finish-login',{});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
 return {...f,app,service,get,post,close:async()=>{await app.close();await rm(runtime,{recursive:true,force:true});}};
}
test('a genuine no-new-quota archive exposes only its independently proved timed reduction for confirmation',async()=>{
 const x=await scopedApp();try{
  const decision=getDualActivityDecision(x.journal,x.shopId,x.productId);assert.equal(dualPriceApprovalReady(decision),true);assert.equal(decision.schemes.find(s=>s.type==='限量抢购').scopeExcluded,true);
  const before=material(x.journal),list=await x.get('recovery-workspace?scope=confirm'),automatic=await x.get('recovery-workspace?scope=automatic');
  assert.equal(list.total,1);assert.equal(automatic.total,0);assert.equal(list.records[0].approvalAllowed,true);assert.deepEqual(list.records[0].schemes.map(s=>s.classification),['reduction-required','unavailable']);assert.match(list.records[0].schemes.find(s=>s.type==='限量抢购').reason,/额度|限量/);
  const item=await x.get('price-reviews/item?productId='+x.productId);assert.equal(item.approvalAllowed,true);assert.equal(item.review.type,'限时抢购');assert.ok(item.review.options.some(o=>o.available&&o.activityType==='限时抢购'));assert.equal(item.review.options.some(o=>o.available&&o.activityType==='限量抢购'),false);
  assert.equal(material(x.journal),before);assert.equal(x.journal.get(x.task.id).phase,'blocked');assert.equal(x.journal.get(x.task.id).submitAttempts,1);assert.equal(x.journal.priceTarget(x.shopId,x.productId),null);
 }finally{await x.close();}
});
test('a genuine restricted scope with a legal non-reducing timed plan stays automatic and creates no confirmation',async()=>{
 const x=await scopedApp({timedCapFen:null});try{
  const before=material(x.journal);assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);const list=await x.get('recovery-workspace?scope=automatic');assert.equal(list.total,1);assert.equal(list.records[0].approvalAllowed,false);assert.equal(list.records[0].schemes.find(s=>s.type==='限时抢购').classification,'non-reducing');assert.equal(x.journal.priceTarget(x.shopId,x.productId),null);assert.equal(material(x.journal),before);
 }finally{await x.close();}
});
