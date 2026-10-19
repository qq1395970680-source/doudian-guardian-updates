import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
test('failed historical pages consume a bounded budget and do not starve later history',async()=>{
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});let reads=0;
 const campaigns=Array.from({length:45},(_,i)=>({id:String(400001+i),status:'已结束',startAt:Date.now()-i*10000}));
 platform.list=async()=>({campaigns,complete:true,observedAt:Date.now()});platform.detail=async()=>{reads++;throw Object.assign(new Error('cannot read'),{code:'LOAD_TIMEOUT'});};
 try{await platform.discover();assert.equal(reads,20);await platform.discover();assert.equal(reads,40);await platform.discover();assert.equal(reads,45);}finally{journal.close();}
});
test('a missing active detail prevents any loss claim, even when ended history exists',async()=>{
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});
 platform.list=async()=>({campaigns:[{id:'400001',status:'进行中',startAt:Date.now()}],complete:true,observedAt:Date.now()});platform.detail=async()=>{throw Error('read failed');};
 try{const d=await platform.discover();assert.equal(d.activeComplete,false);await assert.rejects(platform.loss({productId:'300001'}),{code:'ACTIVE_UNKNOWN'});}finally{journal.close();}
});
