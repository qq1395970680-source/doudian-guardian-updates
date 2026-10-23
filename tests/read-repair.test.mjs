import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {assertReadonlyRepair,repairReadonlyService} from '../desktop/read-repair.mjs';
import {ownedProcessCommand} from '../desktop/owned-processes.mjs';

const original={instance:'owned',sourceBuild:'abc',startedAt:Date.now(),shopId:'900001',running:true,busy:true,unknown:0,action:null,loginOpen:false,tasks:[],progress:{stage:'核对当前活动'}};
test('read-only repair rejects writing, unknown, truncated, login and unproven states before process control',()=>{
 for(const bad of [{unknown:1},{tasks:[{phase:'prepared'}]},{tasks:Array.from({length:100},()=>({phase:'verified'}))},{loginOpen:true},{action:'执行迁移'},{progress:{stage:'独立页面逐规格回读'}}])assert.throws(()=>assertReadonlyRepair({...original,...bad}));
 assert.doesNotThrow(()=>assertReadonlyRepair(original));
});
for(const failure of ['none','missing-stop-ack','different-instance','running-after-stop'])test(`controlled legacy repair ${failure} requires fresh identity and stop acknowledgement`,async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-read-repair-')),root=join(runtime,'versions','old');await mkdir(root,{recursive:true});await writeFile(join(root,'bundle-info.json'),JSON.stringify({sourceBuild:original.sourceBuild}));
 const calls=[];let probes=0;
 const stopped={...original,running:false,ok:true};
 try{
  const action=repairReadonlyService({url:'http://127.0.0.1:19000',runtime,validate:async()=>{},sleep:async()=>{},
   readRecord:async()=>({pid:123,sourceRoot:root,url:'http://127.0.0.1:19000',startedAt:original.startedAt,sourceBuild:original.sourceBuild,shopId:original.shopId}),
   probe:async()=>++probes===1?{state:'ready',status:original}:probes===2?{state:'ready',status:failure==='different-instance'?{...stopped,instance:'changed'}:failure==='running-after-stop'?original:stopped}:{state:'absent'},
   control:async()=>{calls.push('stop');return failure==='missing-stop-ack'?{...stopped,ok:false}:stopped;},
   inspect:async()=>{calls.push('inspect');return[{pid:123,created:'exact'}];},terminate:async()=>{calls.push('terminate');},start:async()=>calls.push('start')});
  if(failure==='none'){assert.equal((await action).state,'restarted');assert.deepEqual(calls,['inspect','stop','terminate','start']);}
  else{await assert.rejects(action);assert.ok(!calls.includes('terminate'));assert.ok(!calls.includes('start'));}
 }finally{await rm(runtime,{recursive:true,force:true});}
});
test('native maintenance helper refuses a changed PID identity and only stops an isolated owned child',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-owned-child-'));await mkdir(join(root,'src'));await writeFile(join(root,'src','server.mjs'),"console.log('ready');setInterval(()=>{},1000);");
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']}),startedAt=Date.now();
 try{
  await once(child.stdout,'data');const expected={pid:child.pid,exe:process.execPath,startedAt,sourceRoot:root,runtime:root};
  const identity=await ownedProcessCommand('inspect',expected);assert.ok(identity.length>=1);assert.equal(identity[0].pid,child.pid);
  await assert.rejects(ownedProcessCommand('terminate',expected,identity.map(e=>({...e,created:'different'}))));
  assert.equal(child.exitCode,null);const exited=once(child,'exit');assert.equal((await ownedProcessCommand('terminate',expected,identity)).closed,true);await exited;
 }finally{if(child.exitCode===null)child.kill();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
