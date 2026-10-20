import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
const initial=1792437600000;
function fixture(){
 let now=initial;const journal=new Journal(':memory:'),shopId='900001';
 const baselines=Array.from({length:8},(_,i)=>({source:'verified-platform-history',complete:true,shopId,productId:String(300001+i),campaignId:String(400001+i),name:'商品'+i,type:'限时抢购',historyAt:initial-10000,
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:String(500001+i),name:'原规格',baseFen:10000,discount:50}]}));
 const reads=[],discoveries=[],lossKeys=new Map(),active=new Set();
 const platform={discover:async options=>{discoveries.push(options);return{baselines,activeComplete:true};},
  loss:async b=>({complete:true,active:active.has(b.productId),lossKey:lossKeys.get(b.productId)||b.productId+'-drop1',observedAt:now}),
  precheck:async b=>{reads.push(b.productId);throw Object.assign(Error('完整选品列表未找到商品'),{code:'NOT_FOUND'});}};
 const service=new GuardianService({journal,platform,policy:{shopId,liveEnabled:true,cutoverConfirmed:true},now:()=>now});
 return{journal,service,reads,discoveries,lossKeys,active,baselines,advance:ms=>now+=ms};
}
test('unchanged known blockers do not repeat expensive selection scans on every patrol',async()=>{
 const f=fixture();try{await f.service.tick();assert.equal(f.reads.length,8);f.reads.length=0;f.advance(60000);await f.service.tick();assert.equal(f.reads.length,0);
  const checks=f.journal.productChecks('900001');assert.equal(checks.length,8);assert.ok(checks.every(c=>c.code==='NOT_FOUND'&&c.retryAt>initial));
 }finally{f.journal.close();}
});
test('due old blockers run after a new loss rather than waiting several more patrols',async()=>{
 const f=fixture();try{await f.service.tick();f.reads.length=0;f.advance(16*60000);f.lossKeys.set('300008','new-loss');await f.service.tick();
  assert.equal(f.reads[0],'300008');assert.equal(f.reads.length,8);
 }finally{f.journal.close();}
});
test('a product observed active and subsequently removed bypasses its previous cooldown',async()=>{
 const f=fixture();try{await f.service.tick();f.active.add('300001');f.advance(60000);await f.service.tick();f.active.clear();f.reads.length=0;f.advance(60000);await f.service.tick();assert.deepEqual(f.reads,['300001']);}
 finally{f.journal.close();}
});
test('current patrol does not reread deep history each round and shop checks remain isolated',async()=>{
 const f=fixture();try{for(const b of f.baselines)f.journal.remember(b);await f.service.tick();assert.equal(f.discoveries[0].historyReadLimit,0);
  f.advance(16*60000);await f.service.tick();assert.equal(f.discoveries[1].historyReadLimit,2);assert.deepEqual(f.journal.productChecks('900002'),[]);
 }finally{f.journal.close();}
});
