import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {PriorityWatch} from '../src/priority-watch.mjs';
import {recoveryBatches,readBatchProducts} from '../src/recovery-batches.mjs';
import {makeTransfer,importTransfer} from '../src/migration.mjs';

const now=1792440000000;
const baseline=i=>({source:'verified-platform-history',complete:true,shopId:'900001',productId:String(300000+i),name:'商品'+i,
 campaignId:'400001',type:'限量抢购',rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
 durationMs:7*86400000,activityLimit:1000,skus:Array.from({length:10},(_,j)=>({id:String(600000+i*10+j),name:'规格'+j,baseFen:10000,discount:60}))});
for(const priority of [false,true])test(`500 product store restores the first 50 before reading later SKU batches (${priority?'priority':'ordinary'})`,async()=>{
 const journal=new Journal(':memory:'),baselines=Array.from({length:500},(_,i)=>baseline(i)),prechecks=[],executions=[];
 for(const b of baselines)journal.remember(b);
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const platform={
  discover:async()=>({activeComplete:true,baselines:[]}),
  loss:async b=>({complete:true,active:false,observedAt:now,lossKey:b.productId}),
  lossBatch:async bs=>bs.map(b=>({productId:b.productId,loss:{complete:true,active:false,observedAt:now,lossKey:b.productId}})),
  precheck:async()=>assert.fail('the native batch adapter must not open one form per product'),
  precheckBatch:async bs=>{prechecks.push(bs.length);assert.equal(executions.length,prechecks.length-1,'execute completed group before later SKU work');return bs.map(b=>({...b,observedAt:now}));}
 };
 const service=new GuardianService({journal,platform,policy,now:()=>now});
 service.execute=async task=>{executions.push(task.plans);assert.ok(task.plans.length<=50);assert.ok(task.plans.reduce((n,p)=>n+p.skus.length,0)<=500);};
 try{
  if(priority){service.priorityWatch=new PriorityWatch(journal,policy.shopId);service.priorityListing={campaigns:[]};
   await service.recoverPriority(baselines.map(b=>({productId:b.productId,watchKey:'lost'})));
   assert.equal(executions.length,1,'priority boundary remains bounded');assert.equal(executions[0].length,50);
  }else{
   await service.tick();assert.equal(service.lastRun.ok,true,service.lastRun.message);
   assert.equal(executions.length,10);assert.equal(executions.flat().length,500);
  }
  assert.ok(prechecks.every(n=>n===50));
 }finally{journal.close();}
});

test('shared fresh loss evidence reads each campaign once for 50 removed products and retains limited sold-out guard',async()=>{
 const baselines=Array.from({length:50},(_,i)=>baseline(i));
 const platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}}),observedAt=Date.now();
 let lists=0,details=0;
 const campaign={id:'400001',name:'共同限量活动',status:'进行中',type:'限量抢购',startAt:now,endAt:now+7*86400000};
 platform.ensure=async()=>{};
 platform.listActive=async()=>{lists++;return{complete:true,observedAt,campaigns:[campaign]};};
 platform.detail=async()=>{details++;return{complete:true,observedAt,products:baselines.map((b,i)=>({...b,removalConfirmed:true,removalRiskConfirmed:true,soldOut:i===49}))};};
 const results=await platform.lossBatch(baselines);
 assert.equal(lists,2);assert.equal(details,1);assert.equal(results.length,50);
 assert.ok(results.slice(0,49).every(r=>r.loss?.complete&&r.loss.active===false&&r.loss.observedAt===observedAt));
 assert.equal(results[49].error.code,'LIMITED_LOSS_UNPROVEN');
});

test('shared loss evidence rejects a changed current list and drains failed detail readers',async()=>{
 const platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});platform.ensure=async()=>{};
 let reading=0,done=0;
 platform.listActive=async()=>({complete:true,observedAt:Date.now(),campaigns:[{id:'400001',status:'进行中'},{id:'400002',status:'进行中'}]});
 platform.detail=async c=>{reading++;try{await new Promise(r=>setTimeout(r,c.id==='400001'?1:20));if(c.id==='400001')throw Error('read failed');return{complete:true,observedAt:Date.now(),products:[]};}finally{reading--;done++;}};
 await assert.rejects(()=>platform.lossBatch(Array.from({length:6},(_,i)=>baseline(i))),/read failed/);
 assert.equal(reading,0);assert.equal(done,2);
 let lists=0;
 platform.listActive=async()=>({complete:true,observedAt:Date.now(),campaigns:++lists===1?[]:[{id:'400003',status:'进行中'}]});
 await assert.rejects(()=>platform.lossBatch(Array.from({length:6},(_,i)=>({...baseline(i),type:'限时抢购'}))),{code:'ACTIVE_CHANGED'});
});

test('batches preserve discount groups, SKU budget, and every product exactly once',()=>{
 const members=Array.from({length:130},(_,i)=>({baseline:{...baseline(i),
  skus:Array.from({length:i<60?20:5},(_,j)=>({...baseline(i).skus[j%10],discount:i%2?60:50}))}}));
 const batches=recoveryBatches(members);
 assert.equal(batches.flat().length,130);assert.equal(new Set(batches.flat().map(m=>m.baseline.productId)).size,130);
 assert.ok(batches.every(b=>b.length<=50&&b.reduce((n,m)=>n+m.baseline.skus.length,0)<=500));
 assert.ok(batches.every(b=>new Set(b.flatMap(m=>m.baseline.skus.map(s=>s.discount))).size===1));
});

test('one unavailable product is isolated by read-only batch splitting and cannot alter neighboring prices',async()=>{
 const members=Array.from({length:20},(_,i)=>({baseline:baseline(i)})),calls=[];
 const read=async bs=>{calls.push(bs.length);if(bs.some(b=>b.productId==='300007'))throw Object.assign(Error('not found'),{code:'NOT_FOUND'});return bs.map(b=>({...b,observedAt:now}));};
 const result=await readBatchProducts({precheckBatch:read,precheck:async b=>(await read([b]))[0]},members);
 assert.equal(result.length,20);assert.equal(result.filter(r=>r.current).length,19);
 assert.equal(result.find(r=>r.error).member.baseline.productId,'300007');
 for(const r of result.filter(r=>r.current))assert.deepEqual(r.current.skus,r.member.baseline.skus);
 assert.ok(calls.length<20,'a single bad row must not turn the whole batch into one-page-per-product');
});

test('batch recovery excludes pending submissions, changed base prices, and active products',async()=>{
 const journal=new Journal(':memory:'),bs=Array.from({length:20},(_,i)=>baseline(i)),executed=[];
 bs.forEach(b=>journal.remember(b));
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true,excludedProductIds:['300001']};
 const platform={discover:async()=>({activeComplete:true,baselines:[]}),
  loss:async b=>({complete:true,active:false,observedAt:now,lossKey:b.productId}),
  lossBatch:async rows=>rows.map(b=>({productId:b.productId,loss:{complete:true,active:b.productId==='300003',campaignId:'400002',observedAt:now,lossKey:b.productId}})),
  precheckBatch:async rows=>rows.map(b=>({...b,observedAt:now,skus:b.skus.map(s=>({...s,baseFen:b.productId==='300002'?11000:s.baseFen}))})),
  precheck:async b=>({...b,observedAt:now}),
  readback:async()=>null};
 const service=new GuardianService({journal,platform,policy,now:()=>now});service.recovered=true;
 const p=service.restorePlan(bs[0],{...bs[0],observedAt:now});
 const unknown=journal.enqueue(policy.shopId,[p],{complete:true,observedAt:now,lossKey:'pending'},now);
 // Persist an interrupted submission as the normal restart boundary would.
 journal.transition(unknown.id,'queued','prepared',{},now);journal.transition(unknown.id,'prepared','submitting',{submitAttempts:1},now);
 journal.transition(unknown.id,'submitting','unknown',{},now);
 service.execute=async t=>executed.push(...t.plans);
 try{
  await service.tick();
  assert.equal(executed.length,16);
  assert.ok(executed.every(p=>!['300000','300001','300002','300003'].includes(p.productId)));
  assert.equal(journal.get(unknown.id).submitAttempts,1);assert.equal(journal.get(unknown.id).phase,'unknown');
 }finally{journal.close();}
});

test('large evidence expiry shrinks batches before any write without renewing stale timestamps',async()=>{
 const journal=new Journal(':memory:'),members=Array.from({length:20},(_,i)=>({baseline:baseline(i)})),sizes=[];
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const platform={precheckBatch:async bs=>bs.map(b=>({...b,observedAt:now})),precheck:async b=>({...b,observedAt:now}),
  lossBatch:async bs=>{if(bs.length>5)throw Object.assign(Error('slow snapshot'),{code:'BATCH_PROOF_EXPIRED'});
   return bs.map(b=>({productId:b.productId,loss:{complete:true,active:false,observedAt:now-10,lossKey:b.productId}}));}};
 const service=new GuardianService({journal,platform,policy,now:()=>now});
 service.execute=async t=>{sizes.push(t.plans.length);assert.equal(t.lossEvidence.observedAt,now-10);};
 try{await service.recoverBatch(members,(_,error)=>assert.fail(error.message));assert.deepEqual(sizes,[5,5,5,5]);}
 finally{journal.close();}
});

test('a 50-product unknown batch survives transfer to another computer without new write permissions',()=>{
 const journal=new Journal(':memory:'),destination=new Journal(':memory:'),bs=Array.from({length:50},(_,i)=>baseline(i));
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const service=new GuardianService({journal,platform:{},policy,now:()=>now});
 try{
  bs.forEach(b=>journal.remember(b,now));
  const task=journal.enqueue(policy.shopId,bs.map(b=>service.restorePlan(b,{...b,observedAt:now})),{complete:true,observedAt:now,lossKey:'test'},now);
  journal.transition(task.id,'queued','prepared',{},now);journal.transition(task.id,'prepared','submitting',{submitAttempts:1},now);
  journal.transition(task.id,'submitting','unknown',{},now);
  const file=makeTransfer(journal,{shopId:policy.shopId},{version:'2.0.0-beta.16',now});
  const result=importTransfer(destination,file,{shopId:policy.shopId,accepted:true,expectedDigest:file.digest},now);
  assert.equal(result.unknown,1);
  const imported=destination.get(task.id);assert.equal(imported.plans.length,50);assert.equal(imported.submitAttempts,1);assert.equal(imported.riskAttempts,1);
  assert.equal(imported.phase,'unknown');assert.ok(imported.plans.every(p=>!p.originalRiskAllowed&&!p.approvedRiskAllowed));
 }finally{journal.close();destination.close();}
});

test('a platform SKU ratio rejection blocks only its member and never resubmits its rejected prices',async()=>{
 const journal=new Journal(':memory:'),members=Array.from({length:50},(_,i)=>({baseline:baseline(i)})),executed=[],blocked=[];
 members[7].baseline.skus[9].baseFen=100000;
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const platform={precheckBatch:async bs=>bs.map(b=>({...b,observedAt:now})),
  lossBatch:async bs=>bs.map(b=>({productId:b.productId,loss:{complete:true,active:false,observedAt:now,lossKey:b.productId,
   ...(b.productId==='300007'?{removal:{productId:b.productId,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}}:{})}}))};
 const service=new GuardianService({journal,platform,policy,now:()=>now});
 service.execute=async task=>executed.push(...task.plans);
 try{
  await service.recoverBatch(members,(member,error)=>blocked.push({id:member.baseline.productId,code:error.code}));
  assert.equal(executed.length,49);assert.ok(executed.every(p=>p.productId!=='300007'));
  assert.deepEqual(blocked,[{id:'300007',code:'SKU_RATIO_REVIEW_REQUIRED'}]);
  assert.ok(members.every(m=>m.baseline.skus.every(s=>s.discount===60)));
 }finally{journal.close();}
});
