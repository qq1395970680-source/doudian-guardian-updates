import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
const now=1792452000000,policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true};
test('completed patrol and last success survive restart only as same-shop display state',async()=>{
 const j=new Journal(':memory:'),platform={discover:async()=>({activeComplete:true,baselines:[]})};let clock=now;
 try{
  const first=new GuardianService({journal:j,platform,policy,now:()=>clock});await first.tick();const success=first.lastRun;
  clock+=60000;platform.discover=async()=>{throw Object.assign(Error('read failed'),{code:'LOAD_TIMEOUT'});};await first.tick();
  const resumed=new GuardianService({journal:j,platform,policy:{...policy,liveEnabled:false},now:()=>clock});
  assert.equal(resumed.status().lastRun.ok,false);assert.deepEqual(resumed.status().lastSuccessfulRun,success);assert.equal(resumed.running,false);
  await assert.rejects(resumed.tick(),{code:'CUTOVER_REQUIRED'});
  assert.equal(new GuardianService({journal:j,platform,policy:{...policy,shopId:'900002'},now:()=>clock}).status().lastRun,null);
 }finally{j.close();}
});
test('arbitrary diagnostics or future patrol display values are not accepted as completed patrols',()=>{
 const j=new Journal(':memory:'),platform={};try{
  j.putSettings('patrol-display:900001',{schema:1,shopId:'900001',source:'external-diagnostic',lastRun:{startedAt:now,finishedAt:now,ok:true}});
  assert.equal(new GuardianService({journal:j,platform,policy,now:()=>now}).lastRun,null);
  j.putSettings('patrol-display:900001',{schema:1,shopId:'900001',source:'completed-program-patrol',lastRun:{startedAt:now,finishedAt:now+60000,ok:true}});
  assert.equal(new GuardianService({journal:j,platform,policy,now:()=>now}).lastRun,null);
 }finally{j.close();}
});

test('a patrol stopped after its scan cannot replace the last successful completion',async()=>{
 const j=new Journal(':memory:'),platform={discover:async()=>({activeComplete:true,baselines:[]})};let clock=now;
 const service=new GuardianService({journal:j,platform,policy,now:()=>clock});
 try{
  await service.tick();const success=service.lastSuccessfulRun;
  clock+=60000;platform.discover=async()=>{service.stop();return{activeComplete:true,baselines:[]};};
  await service.tick();assert.equal(service.lastRun.ok,false);assert.equal(service.lastRun.code,'STOPPED');assert.deepEqual(service.lastSuccessfulRun,success);
  const resumed=new GuardianService({journal:j,platform,policy,now:()=>clock});assert.deepEqual(resumed.lastSuccessfulRun,success);assert.equal(resumed.lastRun.ok,false);
 }finally{j.close();}
});
