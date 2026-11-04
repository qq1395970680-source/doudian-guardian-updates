import test from 'node:test';
import assert from 'node:assert/strict';
import {GuardianService} from '../src/service.mjs';

const now=1793754000000,shopId='900001',productId='3000000000000000001';
function fixture(){
 const settings=new Map(),events=[],calls=[];
 const old={id:'old-unknown',shopId,title:'守护2-old',phase:'unknown',createdAt:now-86400000,submittedAt:now-86400000,submitAttempts:1,riskAttempts:0,plans:[{productId,historicalFingerprint:'history'}]};
 const journal={settings:k=>settings.get(k),putSettings:(k,v)=>settings.set(k,v),list:()=>[old],event:(...args)=>events.push(args),unresolvedRecoveries:()=>[],enqueue:(...args)=>{calls.push(args);return{id:'new'};}};
 let investigations=0,submits=0;
 const platform={readback:async()=>null,investigateSubmission:async()=>{investigations++;return{finishedAt:now,diagnosticOnly:true,authorizesSubmit:false,assessment:{reason:'当前完整查询未找到原活动，历史结果仍未知'}};},submit:async()=>{submits++;}};
 const service=new GuardianService({journal,platform,policy:{shopId},now:()=>now});
 return{old,journal,platform,service,settings,calls,counts:()=>({investigations,submits})};
}
test('long unknown escalates once to a full diagnostic without resetting counters or submitting',async()=>{
 const f=fixture(),original=structuredClone(f.old);
 assert.equal(await f.service.reconcile(f.old),false);assert.equal(await f.service.reconcile(f.old),false);
 assert.deepEqual(f.counts(),{investigations:1,submits:0});assert.deepEqual(f.old,original);
 assert.equal(f.settings.get('submission-full-investigation:'+shopId+':old-unknown').authorizesSubmit,false);
});
test('recent unknown continues independent readback without expensive historical investigation',async()=>{
 const f=fixture();f.old.submittedAt=now-1000;assert.equal(await f.service.reconcile(f.old),false);
 assert.deepEqual(f.counts(),{investigations:0,submits:0});
});
test('only a source-matching archived lifecycle receives its explicit successor key',()=>{
 const f=fixture(),plan={shopId,productId,historicalFingerprint:'history'},closure={id:'closure-1',productIds:[productId],sourceReferences:[{productId,historicalFingerprint:'history'}]};
 f.journal.unresolvedRecoveries=()=>[{closure,successor:null}];
 f.service.enqueueRecovery(shopId,[plan],{lossKey:'current-live-loss'},now);
 assert.equal(f.calls[0][2].unresolvedRecoveryClosureId,'closure-1');
 f.service.enqueueRecovery(shopId,[{...plan,historicalFingerprint:'different-history'}],{lossKey:'other-live-loss'},now);
 assert.equal(f.calls[1][2].unresolvedRecoveryClosureId,undefined);
});
test('a verified successor does not restrict a later genuine recovery lifecycle',()=>{
 const f=fixture(),plan={shopId,productId,historicalFingerprint:'history'};
 f.journal.unresolvedRecoveries=()=>[{closure:{id:'closure-1',productIds:[productId],sourceReferences:[{productId,historicalFingerprint:'history'}]},successor:{taskId:'new-verified'}}];
 f.journal.get=()=>({phase:'verified'});
 f.service.enqueueRecovery(shopId,[plan],{lossKey:'later-live-loss'},now);
 assert.equal(f.calls[0][2].unresolvedRecoveryClosureId,undefined);
});
test('an archived product cannot share a successor task with an unrelated product',()=>{
 const f=fixture(),plan={shopId,productId,historicalFingerprint:'history'};
 f.journal.unresolvedRecoveries=()=>[{closure:{id:'closure-1',productIds:[productId],sourceReferences:[{productId,historicalFingerprint:'history'}]},successor:null}];
 assert.throws(()=>f.service.enqueueRecovery(shopId,[plan,{...plan,productId:'3000000000000000002'}],{lossKey:'fresh'},now),{code:'UNRESOLVED_BATCH_SCOPE'});
 assert.equal(f.calls.length,0);
});
