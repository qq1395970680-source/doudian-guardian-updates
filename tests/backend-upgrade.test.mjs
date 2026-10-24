import test from 'node:test';
import assert from 'node:assert/strict';
import {upgradeService} from '../desktop/service-controller.mjs';
import {BackendUpgrade} from '../desktop/backend-upgrade.mjs';

const old={build:'isolated-headless-journal',version:'2.0.0-beta.30',sourceBuild:'old',instance:'old-instance',startedAt:1000,
 shopId:'900001',running:true,busy:true,unknown:0,action:null,loginOpen:false,tasks:[],progress:{stage:'核对当前活动',read:10,total:20,at:1}};
function fixture(overrides={}){
 let time=0,alive=true,launched=false,current={...structuredClone(old),...overrides};const calls=[],states=[];
 return{calls,states,options:{url:'http://127.0.0.1:19001',shopId:'900001',expectedBuild:'new',expectedVersion:'2.0.0-beta.37',
  timeoutMs:200,stallMs:50,pollMs:10,shutdownWaitMs:50,readyTimeoutMs:50,now:()=>time,sleep:async ms=>{time+=ms;},
  probe:async()=>!alive?{state:'absent'}:{state:'ready',status:launched?{...current,version:'2.0.0-beta.37',sourceBuild:'new',instance:'new-instance',running:true,busy:false}:structuredClone(current)},
  control:async({path,args})=>{calls.push({path,args});if(path==='stop'){current.running=false;return{ok:true,...structuredClone(current)};}alive=false;return{ok:true};},
  takeover:async()=>{calls.push('takeover');alive=false;return{ok:true,state:'stopped',recordsPreserved:true};},
  start:async()=>{calls.push('launch');launched=true;alive=true;},onState:s=>states.push(s)},
  mutate:fn=>fn(current),clock:()=>time};
}
test('stalled old backend is paused, bounded, safely taken over once, and only then reported upgraded',async()=>{
 const f=fixture(),result=await upgradeService(f.options);
 assert.equal(result.state,'upgraded');assert.equal(result.status.sourceBuild,'new');
 assert.equal(f.calls.filter(v=>v==='takeover').length,1);assert.equal(f.calls.filter(v=>v==='launch').length,1);
 assert.ok(f.states.some(s=>s.phase==='stalled'));assert.ok(f.states.some(s=>s.phase==='taking-over'));
 assert.equal(f.states.at(-1).phase,'ready');assert.ok(f.clock()<=300);
});

test('an explicit cancellation after safe takeover never launches or resumes another backend',async()=>{
 const f=fixture();let active=true;f.options.shouldContinue=()=>active;
 const takeover=f.options.takeover;f.options.takeover=async options=>{const proof=await takeover(options);active=false;return proof;};
 const r=await upgradeService(f.options);assert.equal(r.state,'cancelled');assert.ok(!f.calls.includes('launch'));
});
test('a takeover refusal followed by a safe retry preserves the original running intent',async()=>{
 const f=fixture(),coordinator=new BackendUpgrade();f.options.coordinator=coordinator;
 f.options.takeover=async()=>{throw Error('identity temporarily unconfirmed');};
 assert.equal((await upgradeService(f.options)).state,'blocked');
 f.mutate(s=>s.busy=false);coordinator.reset();let resume;
 const start=f.options.start;f.options.start=async options=>{resume=options.resumeOnLaunch;await start(options);};
 assert.equal((await upgradeService(f.options)).state,'upgraded');assert.equal(resume,true);
});
test('real progress cannot extend the overall waiting deadline forever',async()=>{
 const f=fixture(),probe=f.options.probe;let n=10;
 f.options.probe=async()=>{const p=await probe();if(p.status?.sourceBuild==='old')p.status.progress.read=n++;return p;};
 assert.equal((await upgradeService(f.options)).state,'upgraded');assert.ok(f.clock()>=200&&f.clock()<=230);
});

test('failed target build stays blocked across automatic refresh, without replacing another process',async()=>{
 const f=fixture({busy:false}),probe=f.options.probe;f.options.coordinator=new BackendUpgrade();
 f.options.probe=async()=>{const p=await probe();if(p.status?.sourceBuild==='new')p.status.sourceBuild='unexpected-build';return p;};
 assert.equal((await upgradeService(f.options)).code,'UPGRADE_BUILD_MISMATCH');
 assert.equal((await upgradeService(f.options)).code,'UPGRADE_BUILD_MISMATCH');
 assert.equal(f.calls.filter(v=>v==='launch').length,1);
});
test('unknown submissions have a visible deadline and never permit stop, takeover or a second writer',async()=>{
 const f=fixture({unknown:1,tasks:[{phase:'unknown',updatedAt:1}]}),r=await upgradeService(f.options);
 assert.equal(r.state,'blocked');assert.equal(r.code,'UPGRADE_PENDING_SUBMISSIONS');assert.equal(f.calls.length,0);
 assert.ok(f.states.some(s=>s.phase==='waiting-results'));assert.equal(f.states.at(-1).phase,'blocked');
});
test('heartbeat timestamps and alternating list polls cannot hide a stalled detail reader',async()=>{
 const f=fixture(),probe=f.options.probe;let n=0;
 f.options.probe=async()=>{const p=await probe();if(p.status?.sourceBuild==='old'){
  p.status.progress=++n%2?{stage:'读取全店活动列表',page:1,campaigns:20,at:n}:{stage:'核对当前活动',read:10,total:20,at:n};
  p.status.readHealth={active:[{lastProgressAt:n,lastStep:'page.evaluate',operationId:'heartbeat-'+n}]};
 }return p;};
 assert.equal((await upgradeService(f.options)).state,'upgraded');assert.ok(f.clock()<200);
});
test('a launched process is not upgrade completion until its actual version and build match',async()=>{
 const f=fixture({busy:false}),probe=f.options.probe;
 f.options.probe=async()=>{const p=await probe();if(p.status?.sourceBuild==='new')p.status.sourceBuild='unexpected-build';return p;};
 const result=await upgradeService(f.options);assert.equal(result.state,'blocked');assert.equal(result.code,'UPGRADE_BUILD_MISMATCH');
 assert.equal(f.calls.filter(v=>v==='launch').length,1);assert.ok(!f.states.some(s=>s.phase==='ready'));
});
test('no stop acknowledgement means no forced takeover or replacement launch',async()=>{
 const f=fixture();f.options.control=async()=>({ok:true,...old});
 const result=await upgradeService(f.options);assert.equal(result.state,'blocked');assert.equal(result.code,'UPGRADE_STOP_UNCONFIRMED');
 assert.ok(!f.calls.includes('takeover'));assert.ok(!f.calls.includes('launch'));
});
test('a backend instance change during stop preserves both processes for inspection',async()=>{
 const f=fixture(),control=f.options.control;
 f.options.control=async options=>{const ack=await control(options);f.mutate(s=>s.instance='replaced');return ack;};
 const r=await upgradeService(f.options);assert.equal(r.state,'blocked');assert.equal(r.code,'UPGRADE_INSTANCE_CHANGED');
 assert.ok(!f.calls.includes('takeover'));assert.ok(!f.calls.includes('launch'));
});
