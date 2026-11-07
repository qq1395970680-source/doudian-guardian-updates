import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {planOriginalRestore,proveDraft} from '../src/policy.mjs';
import {verificationState} from '../src/verification-schedule.mjs';

// Synthetic, in-memory shop only. No production files, browser or platform.
function fixture(t,{ageMs=7200000}={}){
 const journal=new Journal(':memory:');t.after(()=>journal.close());
 let clock=1794000000000,createdAt=clock-ageMs;
 const shopId='900661',productId='300661',baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400661',
  type:'限时抢购',durationMs:172800000,rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},
  skus:[{id:'500661',name:'测试规格甲',baseFen:10000,discount:60},{id:'500662',name:'测试规格乙',baseFen:20000,discount:60}]};
 const policy={shopId,liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true,allowFurtherPriceReduction:false};
 const plan=planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:createdAt,skus:baseline.skus},policy,createdAt);
 const queued=journal.enqueue(shopId,[plan],{complete:true,observedAt:createdAt,lossKey:'synthetic-proof-failure'},createdAt),
  draft={kind:'draft',shopId,title:queued.title,complete:true,observedAt:createdAt,type:plan.type,rules:plan.rules,startAt:createdAt,endAt:createdAt+plan.durationMs,
   rows:plan.skus.map(s=>({...s,productId})),warnings:[],dialogs:[]};
 journal.transition(queued.id,'queued','prepared',{},createdAt);journal.beginSubmit(queued.id,proveDraft(queued,draft,createdAt),createdAt);
 journal.transition(queued.id,'submitting','unknown',{reason:'synthetic missing response'},createdAt);
 const task=journal.get(queued.id),originalRow=journal.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),calls={readback:0,investigate:0,write:[]};
 const observation=()=>({shopId,title:task.title,campaignId:'400662',complete:true,status:'进行中',observedAt:clock,type:plan.type,rules:structuredClone(plan.rules),
  startAt:draft.startAt,endAt:draft.endAt,rows:plan.skus.map(s=>({...s,productId}))});
 const platform={readback:async()=>{calls.readback++;return observation();},investigateSubmission:async()=>{calls.investigate++;return{
  diagnosticOnly:true,authorizesSubmit:false,finishedAt:clock,assessment:{classification:'ambiguous',mayCloseUnknown:false,authorizesSubmit:false}};}};
 for(const name of ['prepare','submit','resumeOriginalRisk','confirmOriginalRisk','cancelCampaign'])platform[name]=async()=>{calls.write.push(name);assert.fail('Unknown diagnosis cannot enter '+name);};
 const service=new GuardianService({journal,platform,policy,now:()=>clock});
 const unchanged=()=>{assert.deepEqual(journal.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),originalRow);assert.deepEqual(calls.write,[]);};
 return{journal,task,plan,policy,platform,service,observation,calls,unchanged,shopId,productId,setNow:at=>{clock=at;},now:()=>clock,
  key:'submission-full-investigation:'+shopId+':'+task.id,triggerKey:'submission-readback-proof-failure:'+shopId+':'+task.id};
}

for(const mismatch of ['empty','missing-extra','price','rules','mode','range'])test('old unknown '+mismatch+' proof failure invokes only diagnostic investigation',async t=>{
 const f=fixture(t),observation=f.observation();
 const codes={empty:'READBACK_MEMBERSHIP','missing-extra':'READBACK_PRICE',price:'READBACK_PRICE',rules:'READBACK_RULES',mode:'PRICE_MODE_CHANGED',range:'DRAFT_TIME_READBACK'};
 if(mismatch==='empty')observation.rows=[];
 if(mismatch==='missing-extra')observation.rows[1].id='500663';
 if(mismatch==='price')observation.rows[0].saleFen--;
 if(mismatch==='rules')observation.rules.orderMinutes=15;
 if(mismatch==='mode')observation.priceMode='fixed';
 if(mismatch==='range'){observation.startAt+=1000;observation.endAt+=1000;}
 f.platform.readback=async()=>{f.calls.readback++;return structuredClone(observation);};
 await assert.rejects(f.service.reconcileScheduled(f.task),{code:codes[mismatch]});
 assert.equal(f.calls.investigate,1);f.unchanged();
 const diagnostic=f.journal.settings(f.key),trigger=f.journal.settings(f.triggerKey);
 assert.equal(diagnostic.diagnosticOnly,true);assert.equal(diagnostic.authorizesSubmit,false);assert.equal(diagnostic.assessment.classification,'ambiguous');
 assert.deepEqual(trigger,diagnostic.trigger);assert.equal(trigger.code,codes[mismatch]);assert.deepEqual(trigger.observation,observation);
 assert.equal(trigger.membership.expectedRows,2);assert.equal(trigger.membership.actualRows,observation.rows.length);
 if(mismatch==='empty')assert.equal(trigger.membership.missing.length,2);
 if(mismatch==='missing-extra'){assert.deepEqual(trigger.membership.missing,[{productId:f.productId,skuId:'500662'}]);assert.deepEqual(trigger.membership.extra,[{productId:f.productId,skuId:'500663'}]);}
 assert.equal(verificationState(f.journal,f.shopId,f.task).lastError,codes[mismatch]);
});

test('the original one-hour escalation and fifteen-minute investigation interval remain bounded',async t=>{
 const f=fixture(t,{ageMs:3600000-1});f.platform.readback=async()=>({...f.observation(),rows:[]});
 await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});assert.equal(f.calls.investigate,0);
 f.setNow(f.now()+1);await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});assert.equal(f.calls.investigate,1);
 f.setNow(f.now()+15*60000-1);await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});assert.equal(f.calls.investigate,1);
 f.setNow(f.now()+1);await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});assert.equal(f.calls.investigate,2);f.unchanged();
});

test('a diagnostic claiming proven-active cannot bypass the failed strict readback',async t=>{
 const f=fixture(t);f.platform.readback=async()=>({...f.observation(),rows:[]});
 f.platform.investigateSubmission=async()=>{f.calls.investigate++;return{finishedAt:f.now(),assessment:{classification:'proven-active',receipt:{campaignId:'400662'}},diagnosticOnly:true,authorizesSubmit:false};};
 await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});f.unchanged();
 assert.equal(f.journal.get(f.task.id).phase,'unknown');assert.equal(f.journal.get(f.task.id).receipt,undefined);
});

test('only a later exact fresh independent readback verifies the existing task without another submission',async t=>{
 const f=fixture(t);f.platform.readback=async()=>({...f.observation(),rows:[]});
 await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_MEMBERSHIP'});f.unchanged();
 f.setNow(f.now()+1000);f.platform.readback=async()=>f.observation();
 assert.equal(await f.service.reconcile(f.journal.get(f.task.id)),true);
 const after=f.journal.get(f.task.id);assert.equal(after.phase,'verified');assert.equal(after.receipt.campaignId,'400662');
 for(const key of ['plans','draftProof','submittedAt','submitAttempts','riskAttempts'])assert.deepEqual(after[key],f.task[key]);
 assert.deepEqual(f.calls.write,[]);assert.equal(f.calls.investigate,1);
});

test('platform-detected removal proof failure also escalates without risk continuation',async t=>{
 const f=fixture(t);f.platform.readback=async()=>{throw Object.assign(new Error('Synthetic removal mismatch'),{code:'READBACK_REMOVED'});};
 await assert.rejects(f.service.reconcile(f.task),{code:'READBACK_REMOVED'});assert.equal(f.calls.investigate,1);f.unchanged();
 assert.equal(f.journal.settings(f.key).trigger.code,'READBACK_REMOVED');assert.equal(f.journal.settings(f.key).trigger.observation,undefined);
});

for(const code of ['LOGIN_REQUIRED','STOPPED','SHOP_MISMATCH','ACCOUNT_UNKNOWN','READ_CONTEXT_CANCELLED','READ_CLEANUP_BLOCKED','EACCES','READBACK_IDENTITY','READBACK_JOURNAL','DUPLICATE_CAMPAIGN'])test(code+' is preserved without starting fallback reads',async t=>{
 const f=fixture(t),original=Object.assign(new Error('Synthetic boundary failure'),{code});
 f.platform.readback=async()=>{throw original;};
 await assert.rejects(f.service.reconcile(f.task),error=>error===original);assert.equal(f.calls.investigate,0);assert.equal(f.journal.settings(f.key),null);f.unchanged();
});

for(const code of ['LOGIN_REQUIRED','STOPPED','EACCES'])test('investigation '+code+' is not swallowed by a prior proof mismatch',async t=>{
 const f=fixture(t),original=Object.assign(new Error('Synthetic investigation boundary failure'),{code});
 f.platform.readback=async()=>({...f.observation(),rows:[]});f.platform.investigateSubmission=async()=>{f.calls.investigate++;throw original;};
 await assert.rejects(f.service.reconcile(f.task),error=>error===original);f.unchanged();assert.equal(f.calls.investigate,1);
 assert.equal(f.journal.settings(f.key),null);assert.equal(f.journal.settings(f.triggerKey).code,'READBACK_MEMBERSHIP');
});

test('a stop after the readback prevents starting the diagnostic fallback',async t=>{
 const f=fixture(t);f.platform.readback=async()=>{f.service.stopRequested=true;return{...f.observation(),rows:[]};};
 await assert.rejects(f.service.reconcile(f.task),{code:'STOPPED'});assert.equal(f.calls.investigate,0);f.unchanged();
});
