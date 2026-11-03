import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/journal.mjs';
import {planOriginalRestore,proveDraft,fingerprint} from '../src/policy.mjs';
import {interruptForUpgrade,resumeUpgradeHandoff} from '../desktop/active-upgrade.mjs';
import {readUpgradeHandoff,saveUpgradeHandoff,completeUpgradeHandoff} from '../desktop/upgrade-handoff.mjs';
import {interruptedUpgradeJournal} from '../desktop/interrupted-upgrade-journal.mjs';

// Real checkpoint/final backup/normalization and on-disk pending manifests.
// Old/new process probes and termination are local stubs; no live runtime,
// browser, server or process is opened, started, terminated or contacted.
async function fixture(t){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-pending-cutover-')),root=join(runtime,'versions','old');await mkdir(root,{recursive:true});
 const j=new Journal(join(runtime,'guardian.sqlite'));t.after(async()=>{j.close();await rm(runtime,{recursive:true,force:true});});
 const at=Date.now(),shopId='900001',productId='300001',sourceBuild='a'.repeat(64),targetBuild='b'.repeat(64),targetVersion='2.0.0-beta.61';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60}]};
 const plan=planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:at,skus:baseline.skus},{shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true},at);
 j.remember(baseline,at);j.putSettings('application',{selected:shopId});const task=j.enqueue(shopId,[plan],{complete:true,observedAt:at,lossKey:'pending-upgrade-proof'},at);
 const observation={kind:'draft',shopId,title:task.title,type:plan.type,rules:plan.rules,complete:true,observedAt:at,startAt:at,endAt:at+48*3600000,rows:plan.skus.map(s=>({...s,productId})),warnings:[],dialogs:[]};
 j.transition(task.id,'queued','prepared',{},at);j.beginSubmit(task.id,proveDraft(task,observation,at),at);
 await writeFile(join(root,'bundle-info.json'),JSON.stringify({sourceBuild}),'utf8');
 let time=at,active=true,http=true,failedFinalization=true,newStatus=null;
 const pid=123456789,child=123456788,pids=new Set([pid,child]),calls=[];
 const old={instance:'old-pending-instance',sourceBuild,shopId,startedAt:at-1000,running:true,busy:true,unknown:1,action:'已记录提交边界',loginOpen:false};
 const probe=async()=>newStatus?{state:'ready',status:newStatus}:http?{state:'ready',status:{...old}}:{state:'absent'};
 const isAlive=id=>pids.has(id),now=()=>time;
 const journalCheck=async(mode,args)=>{calls.push({mode,...args});if(mode==='interrupt-finalize'&&failedFinalization)throw Error('simulated crash before offline finalization');return interruptedUpgradeJournal({runtime,mode,...args},{probe,isAlive,now});};
 const common={runtime,targetBuild,targetVersion,probe,isAlive,journalCheck,now};
 const options={...common,url:'http://127.0.0.1:19001',expectedInstance:old.instance,resumeOnLaunch:true,graceMs:20,exitMs:30,sleep:async ms=>{time+=ms;},shouldContinue:()=>active,
  readRecord:async()=>({pid,url:'http://127.0.0.1:19001',sourceBuild,sourceRoot:root,shopId,startedAt:at}),validate:async()=>{},
  inspect:async()=>[{pid},{pid:child}],control:async()=>{old.running=false;return{ok:true,...old};},terminate:async()=>{http=false;pids.clear();return{closed:true};}};
 return{j,task,calls,common,options,pids,old,setFailed(value){failedFinalization=value;},cancel(){active=false;},uncancel(){active=true;},setNewStatus(value){newStatus=value;},async manifest(){return readUpgradeHandoff(common);}};
}

test('a crash after old exit retains the exact cutover and requires its successful finalize on reopen',async t=>{
 const f=await fixture(t),before=f.j.get(f.task.id);
 await assert.rejects(interruptForUpgrade(f.options),/simulated crash/);
 const pending=await f.manifest();assert.equal(pending.phase,'prepared');assert.equal(pending.resumeOnLaunch,true);assert.equal(f.pids.size,0);
 assert.equal(f.j.get(f.task.id).phase,'submitting','a failed finalizer never manufactures recovery success');
 f.setFailed(false);const resumed=await resumeUpgradeHandoff(f.common);assert.equal(resumed.state,'finalized');assert.equal(resumed.pending.cutoverId,pending.cutoverId);
 const after=f.j.get(f.task.id);assert.equal(after.phase,'unknown');for(const field of ['plans','title','submitAttempts','riskAttempts','submittedAt','draftProof'])assert.deepEqual(after[field],before[field]);
 const finalizations=f.calls.filter(call=>call.mode==='interrupt-finalize');assert.equal(finalizations.length,2);assert.ok(finalizations.every(call=>call.cutoverId===pending.cutoverId));
 assert.equal(f.calls.filter(call=>call.mode==='interrupt-checkpoint').length,1,'reopen must not replace the original checkpoint');
});

test('cancellation after checkpoint persists the handoff; explicit retry reuses its original resume intent',async t=>{
 const f=await fixture(t),check=f.options.journalCheck;
 f.options.journalCheck=async(mode,args)=>{const result=await check(mode,args);if(mode==='interrupt-checkpoint')f.cancel();return result;};
 await assert.rejects(interruptForUpgrade(f.options),/更新已取消/);const pending=await f.manifest();assert.equal(pending.phase,'prepared');assert.equal(pending.resumeOnLaunch,true);assert.equal(f.old.running,false);assert.equal(f.pids.size,2);
 assert.equal((await resumeUpgradeHandoff(f.common)).state,'old-present');f.uncancel();f.setFailed(false);f.options.resumeOnLaunch=false;
 await interruptForUpgrade(f.options);const final=await f.manifest();assert.equal(final.cutoverId,pending.cutoverId);assert.equal(final.phase,'finalized');assert.equal(final.resumeOnLaunch,true);
 assert.equal(f.calls.filter(call=>call.mode==='interrupt-checkpoint').length,1);
});

test('a surviving owned browser child on reopen blocks finalization despite the vanished old HTTP/root',async t=>{
 const f=await fixture(t);await assert.rejects(interruptForUpgrade(f.options),/simulated crash/);f.pids.add(123456788);f.setFailed(false);
 const attempts=f.calls.length,before=fingerprint(f.j.get(f.task.id));await assert.rejects(resumeUpgradeHandoff(f.common),/专用浏览器仍在/);
 assert.equal(f.calls.length,attempts);assert.equal(fingerprint(f.j.get(f.task.id)),before);assert.equal((await f.manifest()).phase,'prepared');
});

test('another package or an unfinalized new ready backend cannot turn pending metadata into launch authority',async t=>{
 const f=await fixture(t);await assert.rejects(interruptForUpgrade(f.options),/simulated crash/);const before=await readFile(join(f.common.runtime,'updates','active-upgrade-pending.json'),'utf8'),attempts=f.calls.length;
 await assert.rejects(resumeUpgradeHandoff({...f.common,targetBuild:'c'.repeat(64)}),/当前安装包不匹配/);
 f.setNewStatus({sourceBuild:f.common.targetBuild,version:f.common.targetVersion,shopId:f.old.shopId,instance:'unverified-new'});
 await assert.rejects(resumeUpgradeHandoff(f.common),/未经核验的实例/);assert.equal(f.calls.length,attempts);
 assert.equal(await readFile(join(f.common.runtime,'updates','active-upgrade-pending.json'),'utf8'),before);
});

test('launching handoff never repeats launch, and completion requires actual matching build/version/shop/new instance',async t=>{
 const f=await fixture(t);await assert.rejects(interruptForUpgrade(f.options),/simulated crash/);f.setFailed(false);await resumeUpgradeHandoff(f.common);
 const pending=await f.manifest();await saveUpgradeHandoff({...pending,phase:'launching'});const attempts=f.calls.length;
 assert.equal((await resumeUpgradeHandoff(f.common)).state,'launching');assert.equal(f.calls.length,attempts,'a launch marker never creates another normalization or launch');
 const actual={sourceBuild:f.common.targetBuild,version:f.common.targetVersion,shopId:f.old.shopId,instance:'actual-new-instance'};
 for(const change of [{shopId:'900002'},{instance:f.old.instance},{sourceBuild:'c'.repeat(64)},{version:'2.0.0-beta.60'}])await assert.rejects(completeUpgradeHandoff(f.common,{...actual,...change}),/实际身份/);
 assert.ok(await f.manifest());assert.equal(await completeUpgradeHandoff(f.common,actual),true);assert.equal(await f.manifest(),null);assert.equal(f.j.get(f.task.id).phase,'unknown');assert.equal(f.j.get(f.task.id).submitAttempts,1);
});
