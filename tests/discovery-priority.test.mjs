import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
import {Journal} from '../src/journal.mjs';
import {PriorityWatch} from '../src/priority-watch.mjs';
const campaigns=Array.from({length:8},(_,n)=>({id:String(400001+n),name:'活动'+n,type:'限时抢购',status:'进行中',startAt:Math.floor(Date.now()/1000)*1000-n*1000,endAt:Math.floor(Date.now()/1000)*1000-n*1000+48*3600000}));
function fixture(){
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{context:{}},policy:{shopId:'900001'},journal,
  resourceBudget:()=>({detailReaders:6,listReaders:2,overlapListReads:true,keepMonitorPages:true,interBatchDelayMs:0,idleMs:10000})});
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
  assert.deepEqual(seen,[0,6]);assert.deepEqual(f.counts(),{opened:6,closed:6});assert.equal(result.priorityRefreshRequired,true);
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
  assert.equal(boundaries,3);assert.equal(result.activeComplete,true);assert.equal(result.priorityRefreshRequired,false);
  assert.deepEqual(result.baselines.map(b=>b.campaignId),campaigns.map(c=>c.id));
 }finally{f.journal.close();}
});

test('an older newly risk-marked activity is read in the first batch while baseline ordering stays stable',async()=>{
 const f=fixture(),readIds=[],watch=new PriorityWatch(f.journal,'900001'),oldest=campaigns.at(-1);let firstBatch=null;
 watch.observe({...oldest,risk:false},{complete:true,observedAt:Date.now()-1000,products:[{productId:'500008'}]});
 f.listing.campaigns=campaigns.map(c=>({...c,risk:c.id===oldest.id}));
 const read=f.platform.detail.bind(f.platform);f.platform.detail=async c=>{readIds.push(c.id);return read(c);};
 try{
  const result=await f.platform.discover({historyReadLimit:0,onReadBoundary:async({reads})=>{
   assert.equal(f.counts().opened,f.counts().closed);
   if(reads.length&&!firstBatch)firstBatch=reads.map(r=>r.campaign.id);
   for(const {campaign,detail} of reads)watch.observe(campaign,detail);
  }});
  assert.equal(readIds[0],oldest.id);
  assert.deepEqual(firstBatch,[oldest.id],'a new risk must not wait for unrelated pages in a larger pool');
  assert.equal(result.activeComplete,true);
  assert.deepEqual(result.baselines.map(b=>b.campaignId),campaigns.map(c=>c.id),'read priority must not change which historical baseline wins');
  readIds.length=0;await f.platform.discover({historyReadLimit:0});
  assert.equal(readIds[0],campaigns[0].id,'known unchanged risk must not perpetually jump the queue');
 }finally{f.journal.close();}
});
