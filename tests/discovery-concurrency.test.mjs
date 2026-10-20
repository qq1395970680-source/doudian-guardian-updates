import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {buildCatalog} from '../src/catalog.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const campaign=(n,status='进行中')=>({id:String(400000+n),name:'活动'+n,type:'限时抢购',status,startAt:Date.now()-n*1000});
const detail=c=>({complete:true,observedAt:Date.now(),rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:5},
 products:[{productId:String(Number(c.id)+100000),name:c.name,skus:[{id:String(Number(c.id)+200000),name:'原规格',baseFen:10000,discount:50,saleFen:5000}]}]});
function setup(campaigns){const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});
 platform.list=async()=>({complete:true,observedAt:Date.now(),campaigns});return {journal,platform};}
test('fresh inventory overlaps six independent detail reads, caps load, and finishes active pages before older history',async()=>{
 const campaigns=[...Array.from({length:6},(_,i)=>campaign(i+1)),...Array.from({length:4},(_,i)=>campaign(i+7,'已结束'))];
 const {journal,platform}=setup(campaigns);let inFlight=0,peak=0,activeFinished=0;
 platform.detail=async c=>{if(c.status==='已结束')assert.equal(activeFinished,6);peak=Math.max(peak,++inFlight);await pause(10);--inFlight;if(c.status==='进行中')activeFinished++;return detail(c);};
 try{const result=await platform.discover();assert.equal(result.activeComplete,true);assert.equal(result.complete,true);assert.equal(peak,6);assert.equal(inFlight,0);assert.equal(result.baselines.length,10);}finally{journal.close();}
});
test('out of order detail responses preserve stable baseline order',async()=>{
 const campaigns=Array.from({length:5},(_,i)=>campaign(i+1)),{journal,platform}=setup(campaigns);let peak=0,inFlight=0;
 platform.detail=async c=>{peak=Math.max(peak,++inFlight);await pause(c.id==='400001'?30:5);inFlight--;return detail(c);};
 try{const result=await platform.discover();assert.equal(peak,5);assert.deepEqual(result.baselines.map(b=>b.campaignId),campaigns.map(c=>c.id));}finally{journal.close();}
});
test('stopping discovery drains its in-flight reads without starting more pages',async()=>{
 const {journal,platform}=setup(Array.from({length:10},(_,i)=>campaign(i+1)));let reads=0,finished=0,release;
 const blocked=new Promise(r=>{release=r;});
 platform.detail=async c=>{reads++;await blocked;finished++;return detail(c);};
 const action=platform.discover();await pause(10);const started=reads;platform.stopping=true;release();
 try{await assert.rejects(action,{code:'STOPPED'});assert.equal(started,6);assert.equal(reads,6);assert.equal(finished,6);}finally{journal.close();}
});

test('500 current activities use bounded six-page batches and close every reader before a write boundary',async()=>{
 const campaigns=Array.from({length:500},(_,i)=>campaign(i+1)),{journal,platform}=setup(campaigns);
 let inFlight=0,peak=0,total=0;const sizes=[];
 platform.detail=async c=>{inFlight++;peak=Math.max(peak,inFlight);await pause(1);inFlight--;total++;return detail(c);};
 try{
  const result=await platform.discover({onReadBoundary:async({reads})=>{assert.equal(inFlight,0);if(reads.length)sizes.push(reads.length);}});
  assert.equal(result.activeComplete,true);assert.equal(result.errors.length,0);
  assert.equal(total,500);assert.equal(peak,6);assert.equal(sizes.length,84);
  assert.ok(sizes.every(n=>n<=6));assert.equal(new Set(result.baselines.map(b=>b.productId)).size,500);
 }finally{journal.close();}
});

test('a completed detail reaches the live catalog before the other readers finish, without authorizing a loss',async()=>{
 const campaigns=[campaign(1),campaign(2)],{journal,platform}=setup(campaigns);let finishSecond,firstDone;
 const second=new Promise(r=>{finishSecond=r;}),first=new Promise(r=>{firstDone=r;});
 platform.detail=async c=>{if(c.id===campaigns[1].id)await second;else firstDone();return detail(c);};
 const action=platform.discover();await first;await pause(5);
 try{
  assert.ok(platform.inventory,'读取进度必须可见');assert.equal(platform.inventory.activeComplete,false);
  const view=buildCatalog({shopId:'900001',inventory:platform.inventory});assert.equal(view.counts.observedCurrentProducts,1);assert.equal(view.products[0].state,'active');
  assert.equal(journal.settings('catalog-view:900001').details.length,1);
  await assert.rejects(platform.loss({productId:'999999'}),{code:'ACTIVE_UNKNOWN'});
 }finally{finishSecond();await action;journal.close();}
});
