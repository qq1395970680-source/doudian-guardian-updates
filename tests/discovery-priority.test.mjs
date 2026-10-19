import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
import {Journal} from '../src/journal.mjs';
const campaigns=Array.from({length:8},(_,n)=>({id:String(400001+n),name:'活动'+n,type:'限时抢购',status:'进行中',startAt:Date.now()-n*1000}));
function fixture(){
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{context:{}},policy:{shopId:'900001'},journal});
 const listing={complete:true,campaigns,observedAt:Date.now()};let opened=0,closed=0;
 platform.listActive=async()=>listing;
 platform.detail=async c=>{opened++;await new Promise(r=>setTimeout(r,5));closed++;return{complete:true,observedAt:Date.now(),rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:5},products:[{productId:String(+c.id+100000),name:c.name,skus:[{id:String(+c.id+200000),name:'原规格',baseFen:10000,discount:50}]}]};};
 return{journal,platform,listing,counts:()=>({opened,closed})};
}

test('priority checks run between fully closed read batches and can request fresh inventory before the remaining store',async()=>{
 const f=fixture(),seen=[];const fresh={...f.listing,campaigns:campaigns.slice(1),observedAt:Date.now()};
 try{
  const result=await f.platform.discover({historyReadLimit:0,onReadBoundary:async context=>{
   assert.equal(f.counts().opened,f.counts().closed,'priority work must not overlap in-flight detail pages');
   seen.push(context.reads.length);return context.reads.length?{refreshRequired:true,listing:fresh}:null;
  }});
  assert.deepEqual(seen,[0,2]);assert.deepEqual(f.counts(),{opened:2,closed:2});assert.equal(result.priorityRefreshRequired,true);
  assert.equal(result.activeComplete,false);assert.equal(f.platform.inventory.activeComplete,false);
  assert.deepEqual(f.platform.inventory.listing.campaigns.map(c=>c.id),fresh.campaigns.map(c=>c.id));
 }finally{f.journal.close();}
});

test('a priority change at the initial listing avoids all old detail reads',async()=>{
 const f=fixture();try{
  const result=await f.platform.discover({historyReadLimit:0,onReadBoundary:async()=>({refreshRequired:true,listing:f.listing})});
  assert.equal(result.priorityRefreshRequired,true);assert.deepEqual(f.counts(),{opened:0,closed:0});
 }finally{f.journal.close();}
});

test('unchanged priority checks preserve a full discovery and stable historical order',async()=>{
 const f=fixture();let boundaries=0;try{
  const result=await f.platform.discover({historyReadLimit:0,onReadBoundary:async()=>{boundaries++;assert.equal(f.counts().opened,f.counts().closed);}});
  assert.equal(boundaries,5);assert.equal(result.activeComplete,true);assert.equal(result.priorityRefreshRequired,false);
  assert.deepEqual(result.baselines.map(b=>b.campaignId),campaigns.map(c=>c.id));
 }finally{f.journal.close();}
});
