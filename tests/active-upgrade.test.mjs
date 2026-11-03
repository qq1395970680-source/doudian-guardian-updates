import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {interruptForUpgrade,resumeUpgradeHandoff} from '../desktop/active-upgrade.mjs';
async function fixture(t,{busy=true,unknown=3}={}){const runtime=await mkdtemp(join(tmpdir(),'guardian-active-handoff-')),root=join(runtime,'versions','old');await mkdir(root,{recursive:true});const started=Date.now()-5*60000;let time=Date.now(),alive=true,pidAlive=true,current={instance:'old',sourceBuild:'a'.repeat(64),shopId:'900001',startedAt:started,running:true,busy,unknown,action:busy?'当前仍在提交':null,loginOpen:false};await writeFile(join(root,'bundle-info.json'),JSON.stringify({sourceBuild:current.sourceBuild}));const record={pid:123456789,sourceBuild:current.sourceBuild,sourceRoot:root,shopId:'900001',url:'http://127.0.0.1:19001',startedAt:time},calls=[];
 t.after(()=>rm(runtime,{recursive:true,force:true}));return{calls,current,options:{runtime,url:record.url,targetBuild:'b'.repeat(64),targetVersion:'2.0.0-beta.61',expectedInstance:'old',readRecord:async()=>record,validate:async()=>{},isAlive:()=>pidAlive,now:()=>time,sleep:async ms=>{time+=ms;},graceMs:30,exitMs:50,probe:async()=>alive?{state:'ready',status:{...current}}:{state:'absent'},control:async({path})=>{calls.push(path);if(path==='stop'){current.running=false;return{ok:true,...current};}alive=false;pidAlive=false;return{ok:true};},inspect:async()=>{calls.push('inspect');return[{pid:record.pid}];},terminate:async()=>{calls.push('terminate');alive=false;pidAlive=false;return{closed:true};},journalCheck:async(mode,args)=>{calls.push(mode);assert.equal(args.expected.instance,'old');if(mode==='interrupt-checkpoint')return{complete:true,checkpointSaved:true,cutoverId:'11111111-1111-1111-1111-111111111111'};assert.equal(alive,false);assert.equal(pidAlive,false);return{complete:true,recordsPreserved:true,tasksCheckpointed:true,oldProcessExited:true};}}};}
test('busy submitting/unknown work is stopped and checkpointed immediately without waiting for completion or a readonly stage',async t=>{const f=await fixture(t),proof=await interruptForUpgrade(f.options);assert.equal(proof.ok,true);assert.deepEqual(f.calls,['inspect','stop','interrupt-checkpoint','terminate','interrupt-finalize']);});
test('an already idle unknown worker can exit gracefully while retaining the same offline recovery proof',async t=>{const f=await fixture(t,{busy:false}),proof=await interruptForUpgrade(f.options);assert.equal(proof.oldProcessExited,true);assert.deepEqual(f.calls,['inspect','stop','interrupt-checkpoint','shutdown','interrupt-finalize']);});
for(const failure of ['no-ack','backup','identity','exit','cancel'])test('active handoff refuses unsafe continuation before any new worker: '+failure,async t=>{const f=await fixture(t);if(failure==='no-ack')f.options.control=async()=>({ok:true,...f.current});if(failure==='backup')f.options.journalCheck=async()=>{throw Error('backup failed');};if(failure==='identity')f.options.expectedInstance='another';if(failure==='exit')f.options.terminate=async()=>({closed:false});if(failure==='cancel')f.options.shouldContinue=()=>false;await assert.rejects(interruptForUpgrade(f.options));assert.ok(!f.calls.includes('interrupt-finalize'));});
test('a vanished root and HTTP port cannot hide an inspected browser child that is still alive',async t=>{const f=await fixture(t,{busy:false}),inspect=f.options.inspect;f.options.inspect=async expected=>[...await inspect(expected),{pid:123456788}];const alive=f.options.isAlive;f.options.isAlive=pid=>pid===123456788||alive(pid);await assert.rejects(interruptForUpgrade(f.options),/旧 HTTP 或进程仍未退出/);assert.ok(!f.calls.includes('interrupt-finalize'));});
test('a native terminate error after natural complete tree exit still requires actual HTTP absence before finalizing',async t=>{
 const f=await fixture(t),terminate=f.options.terminate;f.options.terminate=async(...args)=>{await terminate(...args);throw Error('目标进程不存在或不唯一');};
 const result=await interruptForUpgrade(f.options);assert.equal(result.recordsPreserved,true);assert.equal(f.calls.filter(c=>c==='interrupt-finalize').length,1);
});
test('a native terminate identity error cannot be ignored while any inspected browser child remains alive',async t=>{
 const f=await fixture(t),inspect=f.options.inspect,terminate=f.options.terminate;f.options.inspect=async expected=>[...await inspect(expected),{pid:123456788}];const alive=f.options.isAlive;f.options.isAlive=pid=>pid===123456788||alive(pid);
 f.options.terminate=async(...args)=>{await terminate(...args);throw Error('目标进程不存在或不唯一');};await assert.rejects(interruptForUpgrade(f.options),/目标进程不存在或不唯一/);assert.ok(!f.calls.includes('interrupt-finalize'));
});
test('maintenance 503 and an uncertain socket after graceful shutdown are retried until actual refused plus all PID exits',async t=>{
 const f=await fixture(t,{busy:false}),probe=f.options.probe,control=f.options.control;let remaining=0;f.options.exitMs=500;
 f.options.control=async args=>{const result=await control(args);if(args.path==='shutdown')remaining=2;return result;};
 f.options.probe=async args=>{if(remaining-- >0)throw remaining?Object.assign(Error('后台正在维护或返回异常（503）'),{code:'GUARDIAN_PROBE_HTTP',status:503}):Error('后台连接暂不确定，保留现有进程',{cause:Object.assign(Error('socket reset'),{code:'ECONNRESET'})});return probe(args);};
 assert.equal((await interruptForUpgrade(f.options)).oldProcessExited,true);assert.ok(f.calls.includes('shutdown'));assert.ok(!f.calls.includes('terminate'));assert.equal(f.calls.filter(c=>c==='interrupt-finalize').length,1);
});
test('graceful maintenance uncertainty cannot prevent the already-acknowledged owned worker from being closed safely',async t=>{
 const f=await fixture(t),probe=f.options.probe,check=f.options.journalCheck,terminate=f.options.terminate;let maintenance=false;
 f.options.journalCheck=async(mode,args)=>{const result=await check(mode,args);if(mode==='interrupt-checkpoint')maintenance=true;return result;};
 f.options.probe=async args=>{if(maintenance)throw Error('后台正在维护或返回异常（503）');return probe(args);};
 f.options.terminate=async(...args)=>{const result=await terminate(...args);maintenance=false;return result;};
 assert.equal((await interruptForUpgrade(f.options)).recordsPreserved,true);assert.ok(f.calls.includes('terminate'));assert.ok(f.calls.includes('interrupt-finalize'));
});
test('persistent maintenance uncertainty is never absence and cannot finalize or start a replacement',async t=>{
 const f=await fixture(t),probe=f.options.probe,check=f.options.journalCheck;let maintenance=false;f.options.exitMs=500;
 f.options.journalCheck=async(mode,args)=>{const result=await check(mode,args);if(mode==='interrupt-checkpoint')maintenance=true;return result;};f.options.probe=async args=>{if(maintenance)throw Error('后台正在维护或返回异常（503）');return probe(args);};
 await assert.rejects(interruptForUpgrade(f.options),/旧 HTTP 或进程仍未退出.*503/);assert.ok(!f.calls.includes('interrupt-finalize'));
});
test('uncertain initial identity is still rejected before stop, checkpoint or owned process control',async t=>{const f=await fixture(t);f.options.probe=async()=>{throw Error('503 before identity');};await assert.rejects(interruptForUpgrade(f.options),/503 before identity/);assert.deepEqual(f.calls,[]);});
for(const persistent of [false,true])test('same-cutover recovery retries maintenance without interpreting it as exit: '+persistent,async t=>{
 const f=await fixture(t),check=f.options.journalCheck;f.options.journalCheck=async(mode,args)=>{if(mode==='interrupt-finalize')throw Error('first finalizer interrupted');return check(mode,args);};await assert.rejects(interruptForUpgrade(f.options),/first finalizer/);
 const probe=f.options.probe;let errors=2,finalizations=0;const options={...f.options,waitMs:500,probe:async args=>{if(persistent||errors-- >0)throw Object.assign(Error('maintenance 503'),{code:'GUARDIAN_PROBE_HTTP',status:503});return probe(args);},journalCheck:async(mode,args)=>{finalizations++;return check(mode,args);}};
 if(persistent){await assert.rejects(resumeUpgradeHandoff(options),/连接仍未确定/);assert.equal(finalizations,0);}else{assert.equal((await resumeUpgradeHandoff(options)).state,'finalized');assert.equal(finalizations,1);}
});
for(const failure of ['wrong-identity','http-403','invalid-json'])test('a definitive identity or protocol failure after checkpoint is not downgraded to maintenance: '+failure,async t=>{
 const f=await fixture(t),probe=f.options.probe,check=f.options.journalCheck;let checkpointed=false;f.options.journalCheck=async(mode,args)=>{const result=await check(mode,args);if(mode==='interrupt-checkpoint')checkpointed=true;return result;};
 f.options.probe=async args=>{if(checkpointed){if(failure==='invalid-json')throw new SyntaxError('invalid JSON');throw Object.assign(Error(failure),failure==='wrong-identity'?{code:'GUARDIAN_PROBE_IDENTITY'}:{code:'GUARDIAN_PROBE_HTTP',status:403});}return probe(args);};
 await assert.rejects(interruptForUpgrade(f.options));assert.ok(!f.calls.includes('terminate'));assert.ok(!f.calls.includes('interrupt-finalize'));
});
