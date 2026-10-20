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

test('50 lost products in a 500-activity store use bounded product queries and share their exact origin',async()=>{
 const bs=Array.from({length:50},(_,i)=>baseline(i)),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});
 const origin={id:'400001',name:'原限量活动',status:'进行中',type:'限量抢购',risk:true,endAt:Date.now()+86400000};
 platform.ensure=async()=>{};
 platform.inventory={listing:{campaigns:[origin,...Array.from({length:499},(_,i)=>({id:String(410000+i),status:'进行中'}))]},details:new Map()};
 let inFlight=0,maxInFlight=0,productQueries=0,originQueries=0,detailReads=0;
 platform.listActive=async()=>assert.fail('must not reread 500 unrelated activity details');
 platform.list=async query=>{
  inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
  try{
   await new Promise(r=>setTimeout(r,2));
   if(query?.productId){productQueries++;return{complete:true,observedAt:Date.now(),campaigns:[]};}
   assert.equal(query.title,origin.name);originQueries++;return{complete:true,observedAt:Date.now(),campaigns:[origin]};
  }finally{inFlight--;}
 };
 platform.detail=async c=>{detailReads++;assert.equal(c.id,origin.id);return{complete:true,observedAt:Date.now(),products:[],
  removalExport:{source:'live-platform-removal-export',shopId:'900001',campaignId:origin.id,complete:true,observedAt:Date.now(),
   records:bs.map(b=>({productId:b.productId,reason:'明确风险退出'}))}};};
 const result=await platform.lossBatch(bs);
 assert.equal(result.length,50);assert.ok(result.every(r=>r.loss?.complete&&!r.loss.active));
 assert.equal(productQueries,50);assert.equal(originQueries,1);assert.equal(detailReads,1);
 assert.ok(maxInFlight>2&&maxInFlight<=6);assert.equal(inFlight,0);
});

test('large-store scoped evidence isolates failed queries and retains an active product',async()=>{
 const bs=Array.from({length:10},(_,i)=>({...baseline(i),type:'限时抢购'}));
 const platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});platform.ensure=async()=>{};
 platform.inventory={listing:{campaigns:Array.from({length:40},(_,i)=>({id:String(400000+i),status:'进行中'}))},details:new Map()};
 platform.listActive=async()=>assert.fail('large store must query the requested products');
 let inflight=0;
 platform.list=async ({productId})=>{inflight++;try{
  await new Promise(r=>setTimeout(r,2));
  if(productId==='300000')throw Error('query failed');
  return{complete:productId!=='300001',observedAt:Date.now(),campaigns:productId==='300002'?[{id:'400002',status:'进行中'}]:[]};
 }finally{inflight--;}};
 platform.detail=async()=>({complete:true,observedAt:Date.now(),products:[{productId:'300002'}]});
 const result=await platform.lossBatch(bs);
 assert.equal(result[0].error.message,'query failed');assert.equal(result[1].error.code,'ACTIVE_UNKNOWN');
 assert.equal(result[2].loss.active,true);assert.ok(result.slice(3).every(r=>r.loss?.active===false));assert.equal(inflight,0);
});

test('expired whole-store evidence falls back to scoped proofs without reducing the 50-product batch',async()=>{
 const bs=Array.from({length:50},(_,i)=>({...baseline(i),type:'限时抢购'}));
 const platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});platform.ensure=async()=>{};
 platform.readFreshCurrentInventory=async()=>{throw Object.assign(Error('slow entire store'),{code:'BATCH_PROOF_EXPIRED'});};
 let queries=0;
 platform.list=async({productId})=>{assert.ok(bs.some(b=>b.productId===productId));queries++;return{complete:true,observedAt:Date.now(),campaigns:[]};};
 const result=await platform.lossBatch(bs);
 assert.equal(queries,50);assert.equal(result.length,50);assert.ok(result.every(r=>r.loss?.complete&&!r.loss.active));
});

test('scoped readers preserve stale timestamps and drain outstanding readers on a stop',async()=>{
 const bs=Array.from({length:10},(_,i)=>({...baseline(i),type:'限时抢购'}));
 const p=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});
 let calls=0;
 p.list=async()=>{calls++;return{complete:true,observedAt:Date.now()-180000,campaigns:[]};};
 const stale=await p.scopedLossBatch(bs);
 assert.equal(calls,20);assert.ok(stale.every(r=>r.error?.code==='BATCH_PROOF_EXPIRED'));
 let readers=0;
 p.list=async({productId})=>{readers++;try{
  await new Promise(r=>setTimeout(r,productId==='300000'?1:10));
  if(productId==='300000')throw Object.assign(Error('stopped'),{code:'STOPPED'});
  return{complete:true,observedAt:Date.now(),campaigns:[]};
 }finally{readers--;}};
 await assert.rejects(()=>p.scopedLossBatch(bs),{code:'STOPPED'});assert.equal(readers,0);
});

test('scoped lookup retries one closed read page timeout but does not loop or retry authorization errors',async()=>{
 const p=new DoudianPlatform({browser:{},policy:{shopId:'900001'}}),bs=[{...baseline(0),type:'限时抢购'}];
 let calls=0;
 p.list=async()=>{if(++calls===1)throw Object.assign(Error('slow query'),{name:'TimeoutError'});
  return{complete:true,observedAt:Date.now(),campaigns:[]};};
 assert.equal((await p.scopedLossBatch(bs))[0].loss.active,false);assert.equal(calls,2);
 calls=0;p.list=async()=>{calls++;throw Object.assign(Error('still slow'),{name:'TimeoutError'});};
 assert.equal((await p.scopedLossBatch(bs))[0].error.name,'TimeoutError');assert.equal(calls,2);
 calls=0;p.list=async()=>{calls++;throw Object.assign(Error('signed out'),{code:'LOGIN_REQUIRED'});};
 await assert.rejects(()=>p.scopedLossBatch(bs),{code:'LOGIN_REQUIRED'});assert.equal(calls,1);
});

for(const fresh of [true,false])
test('patrol-aged hints enter fresh batched proof before any task exists: '+fresh,async()=>{
 const journal=new Journal(':memory:'),bs=Array.from({length:100},(_,i)=>baseline(i));
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true},sizes=[],submitted=[];
 bs.forEach(b=>journal.remember(b));
 const platform={
  discover:async()=>({activeComplete:true,baselines:[]}),
  loss:async b=>{throw Object.assign(Error('earlier exact export needs a fresh read'),{
   code:'LOSS_EVIDENCE_EXPIRED',detail:{productId:b.productId,campaignId:'400001'}});},
  precheckBatch:async rows=>rows.map(b=>({...b,observedAt:now})),
  lossBatch:async rows=>{
   sizes.push(rows.length);
   return rows.map(b=>({productId:b.productId,...(fresh?{loss:{complete:true,active:false,observedAt:now,lossKey:'fresh-'+b.productId}}:
    {error:Object.assign(Error('fresh source missing'),{code:'LIMITED_LOSS_UNPROVEN'})})}));
  }
 };
 const service=new GuardianService({journal,platform,policy,now:()=>now});
 service.execute=async task=>{
  assert.equal(task.lossEvidence.complete,true);assert.equal(task.lossEvidence.observedAt,now);
  submitted.push(...task.plans.map(p=>p.productId));
 };
 try{
  await service.tick();
  assert.deepEqual(sizes,[50,50]);
  assert.equal(submitted.length,fresh?100:0);
  if(!fresh)assert.equal(journal.list(policy.shopId).length,0,'old hints never enqueue a task without fresh proof');
  assert.equal(service.lastRun.ok,true);
 }finally{journal.close();}
});
