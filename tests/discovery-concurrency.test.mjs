import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const campaign=(n,status='进行中')=>({id:String(400000+n),name:'活动'+n,type:'限时抢购',status,startAt:Date.now()-n*1000});
const detail=c=>({complete:true,observedAt:Date.now(),rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:5},
 products:[{productId:String(Number(c.id)+100000),name:c.name,skus:[{id:String(Number(c.id)+200000),name:'原规格',baseFen:10000,discount:50,saleFen:5000}]}]});
function setup(campaigns){const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});
 platform.list=async()=>({complete:true,observedAt:Date.now(),campaigns});return {journal,platform};}
test('fresh inventory overlaps two independent detail reads, caps load, and finishes active pages before older history',async()=>{
 const campaigns=[...Array.from({length:6},(_,i)=>campaign(i+1)),...Array.from({length:4},(_,i)=>campaign(i+7,'已结束'))];
 const {journal,platform}=setup(campaigns);let inFlight=0,peak=0,activeFinished=0;
 platform.detail=async c=>{if(c.status==='已结束')assert.equal(activeFinished,6);peak=Math.max(peak,++inFlight);await pause(10);--inFlight;if(c.status==='进行中')activeFinished++;return detail(c);};
 try{const result=await platform.discover();assert.equal(result.activeComplete,true);assert.equal(result.complete,true);assert.equal(peak,2);assert.equal(inFlight,0);assert.equal(result.baselines.length,10);}finally{journal.close();}
});
test('out of order detail responses preserve stable baseline order',async()=>{
 const campaigns=Array.from({length:5},(_,i)=>campaign(i+1)),{journal,platform}=setup(campaigns);let peak=0,inFlight=0;
 platform.detail=async c=>{peak=Math.max(peak,++inFlight);await pause(c.id==='400001'?30:5);inFlight--;return detail(c);};
 try{const result=await platform.discover();assert.equal(peak,2);assert.deepEqual(result.baselines.map(b=>b.campaignId),campaigns.map(c=>c.id));}finally{journal.close();}
});
test('stopping discovery drains its in-flight reads without starting more pages',async()=>{
 const {journal,platform}=setup(Array.from({length:10},(_,i)=>campaign(i+1)));let reads=0,finished=0,release;
 const blocked=new Promise(r=>{release=r;});
 platform.detail=async c=>{reads++;await blocked;finished++;return detail(c);};
 const action=platform.discover();await pause(10);const started=reads;platform.stopping=true;release();
 try{await assert.rejects(action,{code:'STOPPED'});assert.equal(started,2);assert.equal(reads,2);assert.equal(finished,2);}finally{journal.close();}
});
