import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {DoudianPlatform} from '../src/platform.mjs';
import {GuardianService} from '../src/service.mjs';
import {Journal} from '../src/journal.mjs';

function fixture({failDetail=false,failMonitor=false}={}){
 const journal=new Journal(':memory:'),policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true};
 let clock=Date.now(),reads=0,reading=0,maxReading=0,polls=0,monitoring=false,releasePoll;
 const campaigns=Array.from({length:12},(_,n)=>({id:String(400001+n),status:'进行中',startAt:clock-n,name:'活动'+n}));
 const listing=()=>({complete:true,observedAt:clock,campaigns});
 const platform=new DoudianPlatform({browser:{context:{}},policy,journal,
  resourceBudget:()=>({detailReaders:6,listReaders:2,overlapListReads:true,keepMonitorPages:true,interBatchDelayMs:0,idleMs:10000})});
 platform.list=platform.listActive=async()=>listing();
 platform.peekActive=async()=>{
  polls++;monitoring=true;await new Promise(resolve=>{releasePoll=resolve;});monitoring=false;
  if(failMonitor)throw Object.assign(Error('monitor disconnected'),{code:'MONITOR_READ'});
  return listing();
 };
 platform.detail=async()=>{
  const index=++reads;reading++;maxReading=Math.max(maxReading,reading);
  try{await immediate();if(index<=2)clock+=16000;
   if(failDetail&&index===7)throw Object.assign(Error('stopping'),{code:'STOPPED'});
   return{complete:true,observedAt:clock,products:[],rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30}};
  }finally{reading--;}
 };
 const service=new GuardianService({journal,platform,policy,now:()=>clock});
 return{journal,platform,service,state:()=>({reads,reading,maxReading,polls,monitoring}),release:()=>releasePoll?.()};
}

test('scheduled list polling overlaps six detail readers instead of blocking the next batch',async()=>{
 const f=fixture(),run=f.service.tick();try{
  for(let n=0;n<5;n++)await immediate();
  assert.equal(f.state().polls,1);assert.equal(f.state().reads,12,'next detail batch must run while the list query is pending');
  assert.equal(f.state().maxReading,6);assert.equal(f.state().monitoring,true);assert.equal(f.service.busy,true);
  f.release();await run;assert.equal(f.state().reads,12);assert.equal(f.service.lastRun.ok,true);assert.equal(f.state().monitoring,false);
 }finally{f.release();await run;f.journal.close();}
});

test('a read interruption drains the in-flight monitor before releasing the service lease',async()=>{
 const f=fixture({failDetail:true}),run=f.service.tick();let finished=false;run.finally(()=>{finished=true;});
 try{
  for(let n=0;n<5;n++)await immediate();
  assert.equal(f.state().reads,12);assert.equal(f.state().monitoring,true);assert.equal(finished,false);assert.equal(f.service.busy,true);
  f.release();await run;assert.equal(f.service.lastRun.code,'STOPPED');assert.equal(f.service.busy,false);assert.equal(f.state().monitoring,false);
 }finally{f.release();await run;f.journal.close();}
});

test('a failed overlapping monitor retains the prior complete list and never enables a write',async()=>{
 const f=fixture({failMonitor:true}),run=f.service.tick();try{
  for(let n=0;n<5;n++)await immediate();assert.equal(f.state().reads,12);f.release();await run;
  assert.equal(f.journal.list('900001').length,0);assert.equal(f.service.lastRun.ok,true);
  assert.ok(f.journal.events(20).some(e=>e.kind==='priority-read-pending'&&e.detail.code==='MONITOR_READ'));
 }finally{f.release();await run;f.journal.close();}
});
