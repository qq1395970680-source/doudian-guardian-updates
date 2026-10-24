import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {ratioFixture} from './helpers/ratio-review-fixture.mjs';
const queue=j=>j.settings('priority-recovery:900001');
const wait=async condition=>{for(let n=0;n<200&&!condition();n++)await new Promise(r=>setTimeout(r,5));assert.ok(condition());};
function fake(f,counters){return{discover:async()=>{counters.scans++;throw Error('Must not wait for or start a full scan');},
 listActive:async()=>({complete:true,observedAt:Date.now(),campaigns:[{id:'400009',status:'进行中'}]}),
 precheck:async()=>{counters.probes++;return{...structuredClone(f.current),observedAt:Date.now()};},
 precheckBatch:async()=>[{...structuredClone(f.current),observedAt:Date.now()}],
 lossBatch:async()=>[{productId:f.baseline.productId,loss:{complete:true,active:true,observedAt:Date.now(),campaignId:'400009'}}]};}
for(const busy of [false,true])test('human price approval dispatches at once or at the next drained read boundary: busy='+busy,async()=>{
 const j=new Journal(':memory:');let s;
 try{
  const f=ratioFixture(j,{now:Date.now()}),r=j.recordRemovalPriceReview(f.plan,f.loss),c={scans:0,probes:0};
  s=new GuardianService({journal:j,platform:fake(f,c),policy:f.policy,immediate:true});s.busy=busy;
  s.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',confirmedSkuIds:r.rows.map(x=>x.id),acceptPriceAndRisk:true});
  assert.equal(queue(j).items.length,1,'Exact confirmation must persist an immediate request before returning');
  if(busy){assert.equal(c.probes,0);await s.checkPriority({listing:{complete:true,observedAt:Date.now(),campaigns:[]},reads:[]});s.busy=false;}
  else await wait(()=>queue(j).items.length===0);
  assert.equal(c.probes,1);assert.equal(c.scans,0);assert.equal(queue(j).items.length,0);assert.equal(j.list(f.policy.shopId).length,0,'A fresh positive activity needs no duplicate submission');
 }finally{s?.stop();j.close();}
});
test('restart retains requests while an explicit stop preserves them paused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-direct-restart-'));let j=new Journal(join(dir,'guardian.sqlite')),s;
 try{
  const f=ratioFixture(j,{now:Date.now()}),c={scans:0,probes:0};s=new GuardianService({journal:j,platform:fake(f,c),policy:f.policy,immediate:true});s.canRunImmediate=()=>false;
  s.requestRecovery([f.baseline.productId]);assert.equal(queue(j).items.length,1);s.stop();j.close();j=new Journal(join(dir,'guardian.sqlite'));
  s=new GuardianService({journal:j,platform:fake(f,c),policy:f.policy,immediate:true});s.wakeImmediate();await wait(()=>queue(j).items.length===0);
  s.requestRecovery([f.baseline.productId]);s.stop({pauseRequests:true});await new Promise(r=>setTimeout(r,30));assert.equal(queue(j).paused,true);assert.equal(queue(j).items.length,1);
  assert.equal(c.probes,1);s.requestRecovery([f.baseline.productId]);await wait(()=>queue(j).items.length===0);assert.equal(c.probes,2);
 }finally{s?.stop();j.close();await rm(dir,{recursive:true,force:true});}
});
test('another lease owner delays an immediate request without a busy retry loop',async()=>{
 const j=new Journal(':memory:');let s;
 try{
  const f=ratioFixture(j,{now:Date.now()}),c={scans:0,probes:0};j.lease(f.policy.shopId,'other-owner',Date.now(),60000);
  s=new GuardianService({journal:j,platform:fake(f,c),policy:f.policy,immediate:true});s.requestRecovery([f.baseline.productId]);
  await wait(()=>queue(j).items[0].retryAt>Date.now()+10000);assert.equal(c.probes,0);assert.equal(c.scans,0);
 }finally{s?.stop();j.close();}
});
