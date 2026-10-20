import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {GuardianService} from '../src/service.mjs';
import {Journal} from '../src/journal.mjs';

for(const scenario of [
 {name:'long successful patrol resumes after ten seconds instead of an idle minute',duration:480000,delay:10000},
 {name:'small shops retain a thirty-second minimum start interval',duration:2000,delay:28000},
 {name:'failed reads retain sixty-second backoff',duration:2000,delay:60000,fail:true}
])test(scenario.name,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let clock=1792460000000,reads=0;
 const journal=new Journal(':memory:'),policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,captureExistingOnly:true};
 const platform={discover:async()=>{reads++;clock+=scenario.duration;if(scenario.fail)throw Error('read unavailable');return{baselines:[],activeComplete:true};}};
 const service=new GuardianService({journal,platform,policy,now:()=>clock});
 try{
  service.start();t.mock.timers.tick(0);await settle();
  assert.equal(reads,1);assert.equal(service.busy,false);assert.equal(service.nextAt-clock,scenario.delay);
  t.mock.timers.tick(scenario.delay-1);await settle();assert.equal(reads,1);
  t.mock.timers.tick(1);await settle();assert.equal(reads,2);
  service.stop();t.mock.timers.tick(120000);await settle();assert.equal(reads,2);assert.equal(service.nextAt,null);
 }finally{service.stop();journal.close();}
});

test('an unfinished patrol does not schedule or overlap a second patrol',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let complete,reads=0;
 const journal=new Journal(':memory:'),policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true};
 const platform={discover:async()=>{reads++;await new Promise(r=>complete=r);return{baselines:[],activeComplete:true};}};
 const service=new GuardianService({journal,platform,policy});
 try{service.start();t.mock.timers.tick(0);await settle();t.mock.timers.tick(120000);await settle();assert.equal(reads,1);assert.equal(service.busy,true);service.stop();complete();await settle();assert.equal(service.nextAt,null);}
 finally{service.stop();complete?.();await settle();journal.close();}
});
