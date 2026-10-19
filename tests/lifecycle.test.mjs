import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';

test('managed shutdown refuses active work and closes an idle dedicated browser gracefully',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-shutdown-')),journal=new Journal(':memory:');let closes=0;
 const service={running:true,busy:false,status:()=>({tasks:[],verified:0,unknown:0,blocked:0}),stop(){this.running=false;}};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal,service,platform:{progress:{}},browser:{close:async()=>{closes++;}}}});
 try{
  const token=(await(await fetch(app.url)).text()).match(/script nonce="([a-f0-9]+)"/)[1];
  const post=()=>fetch(app.url+'/api/shutdown',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  assert.equal((await post()).status,400);assert.equal(closes,0);
  service.running=false;assert.equal((await post()).status,202);
  for(let i=0;i<100&&app.server.listening;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(app.server.listening,false);assert.equal(closes,1);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});

test('explicit idle maintenance preserves an enabled guardian for automatic reconnection after restart',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-restart-')),path=join(runtime,'journal.sqlite');
 const journal=new Journal(path);journal.putSettings('900001',{cutoverConfirmed:true,autoStart:true});let starts=0;
 const makeService=()=>({running:false,busy:false,status:()=>({tasks:[],verified:0,unknown:0,blocked:0}),start(){this.running=true;starts++;},stop(){this.running=false;}});
 const service=makeService(),deps={journal,service,platform:{progress:{},probe:async()=>({shopId:'900001'})},browser:{close:async()=>{}}};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:deps});let restarted;
 try{
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));assert.equal(starts,1);
  const token=(await(await fetch(app.url)).text()).match(/script nonce="([a-f0-9]+)"/)[1];
  const post=()=>fetch(app.url+'/api/shutdown',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify({resumeOnLaunch:true})});
  service.busy=true;assert.equal((await post()).status,400);service.busy=false;
  assert.equal((await post()).status,202);
  for(let i=0;i<100&&app.server.listening;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(app.server.listening,false);
  const saved=new Journal(path);assert.equal(saved.settings('900001').autoStart,true);
  restarted=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{...deps,journal:saved,service:makeService()}});
  while(restarted.snapshot().action)await new Promise(r=>setTimeout(r,10));
  assert.equal(starts,2);assert.equal(restarted.snapshot().connection.shopId,'900001');
 }finally{await app.close();if(restarted)await restarted.close();await rm(runtime,{recursive:true,force:true});}
});
