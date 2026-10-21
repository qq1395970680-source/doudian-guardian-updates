import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
const campaign={id:'400001',name:'活动',status:'进行中',type:'普通降价促销',startAt:Math.floor(Date.now()/1000)*1000-1000,endAt:Math.floor(Date.now()/1000)*1000-1000+48*3600000};
const detail=()=>({complete:true,observedAt:Date.now(),rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:5},products:[{productId:'300001',name:'商品',skus:[{id:'600001',name:'规格',baseFen:10000,discount:50}]}]});
function fixture(){const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});platform.listActive=async()=>({complete:true,observedAt:Date.now(),campaigns:[campaign]});return{journal,platform};}
test('a transient identity timeout gets one new detail read and then full inventory can complete',async()=>{
 const f=fixture();let reads=0;
 f.platform.detail=async()=>{if(++reads===1)throw Object.assign(Error('尚未读取到店铺 ID'),{code:'LOAD_TIMEOUT'});return detail();};
 try{const r=await f.platform.discover({historyReadLimit:0});assert.equal(reads,2);assert.equal(r.activeComplete,true);assert.equal(r.errors.length,0);
  assert.equal(f.journal.events().filter(e=>e.kind==='detail-read-retry').length,1);assert.equal(f.journal.events().filter(e=>e.kind==='detail-read-recovered').length,1);
 }finally{f.journal.close();}
});
test('two timeouts stay incomplete and cannot authorize a missing product',async()=>{
 const f=fixture();let reads=0;f.platform.detail=async()=>{reads++;throw Object.assign(Error('加载未完成'),{code:'LOAD_TIMEOUT'});};
 try{const r=await f.platform.discover({historyReadLimit:0});assert.equal(reads,2);assert.equal(r.activeComplete,false);assert.equal(r.errors.length,1);await assert.rejects(f.platform.loss({productId:'300001'}),{code:'ACTIVE_UNKNOWN'});}finally{f.journal.close();}
});
for(const code of ['SHOP_MISMATCH','ACCOUNT_UNKNOWN','DETAIL_SKUS','STOPPED'])test('identity mismatch, incomplete facts and stop do not retry: '+code,async()=>{
 const f=fixture();let reads=0;f.platform.detail=async()=>{reads++;throw Object.assign(Error('blocked'),{code});};
 try{if(code==='STOPPED')await assert.rejects(f.platform.discover({historyReadLimit:0}),{code});else{const r=await f.platform.discover({historyReadLimit:0});assert.equal(r.activeComplete,false);}assert.equal(reads,1);}finally{f.journal.close();}
});
test('stop during a transient failure prevents the retry',async()=>{
 const f=fixture();let reads=0;f.platform.detail=async()=>{reads++;f.platform.stopping=true;throw Object.assign(Error('timeout'),{code:'LOAD_TIMEOUT'});};
 try{await assert.rejects(f.platform.discover({historyReadLimit:0}),{code:'STOPPED'});assert.equal(reads,1);}finally{f.journal.close();}
});

test('ended history does not consume a second read on a transient timeout',async()=>{
 const f=fixture();let reads=0;
 f.platform.list=async()=>({complete:true,observedAt:Date.now(),campaigns:[{...campaign,status:'已结束'}]});
 f.platform.detail=async()=>{reads++;throw Object.assign(Error('timeout'),{code:'LOAD_TIMEOUT'});};
 try{const r=await f.platform.discover({historyReadLimit:1});assert.equal(reads,1);assert.equal(r.errors.length,1);assert.equal(f.journal.events().filter(e=>e.kind==='detail-read-retry').length,0);}finally{f.journal.close();}
});

test('fresh-page retries keep at most six readers and drain before the priority callback',async()=>{
 const f=fixture(),attempts=new Map();let readers=0,maxReaders=0,boundaries=0;
 const campaigns=Array.from({length:6},(_,i)=>({...campaign,id:String(400001+i)}));
 f.platform.listActive=async()=>({complete:true,observedAt:Date.now(),campaigns});
 f.platform.detail=async c=>{
  readers++;maxReaders=Math.max(maxReaders,readers);const attempt=(attempts.get(c.id)||0)+1;attempts.set(c.id,attempt);
  try{await new Promise(resolve=>setTimeout(resolve,2));if(attempt===1)throw Object.assign(Error('timeout'),{code:'LOAD_TIMEOUT'});return detail();}finally{readers--;}
 };
 try{
  const r=await f.platform.discover({historyReadLimit:0,onReadBoundary:async()=>{boundaries++;assert.equal(readers,0);}});
  assert.equal(r.activeComplete,true);assert.equal(maxReaders,6);assert.equal(readers,0);assert.ok(boundaries>1);assert.equal(attempts.size,6);assert.ok([...attempts.values()].every(n=>n===2));
 }finally{f.journal.close();}
});
