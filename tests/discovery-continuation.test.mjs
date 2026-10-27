import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {DoudianPlatform} from '../src/platform.mjs';

test('an interrupted full scan continues its completed read work instead of restarting fresh on each listing change',async()=>{
 const j=new Journal(':memory:');let clock=Date.now(),calls=[];
 const platform={discover:async options=>{calls.push(options);return calls.length===1?{baselines:[],priorityRefreshRequired:true,activeComplete:false}:{baselines:[],activeComplete:true};}};
 const service=new GuardianService({journal:j,platform,policy:{shopId:'900001',liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]},now:()=>clock});
 try{await service.tick();clock+=1000;await service.tick();assert.ok(calls[1].readOnlyReuseMaxAgeMs>0,'Unchanged completed observations must be reusable for read-only continuation');assert.ok(calls[1].readOnlyReuseMaxAgeMs<=900000);assert.equal(service.lastRun.ok,true);}
 finally{service.stop();j.close();}
});

test('a completed cycle starts fresh again and a continuation cannot exceed the fifteen-minute read-only budget',async()=>{
 const j=new Journal(':memory:');let clock=Date.now(),calls=[];
 const platform={discover:async options=>{calls.push(options);return{baselines:[],activeComplete:true};}};
 const service=new GuardianService({journal:j,platform,policy:{shopId:'900001',liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]},now:()=>clock});
 try{await service.tick();clock+=1000;await service.tick();assert.equal(calls[1].readOnlyReuseMaxAgeMs,undefined);
  service.discoveryCycleStartedAt=clock-900001;await service.tick();assert.equal(calls[2].readOnlyReuseMaxAgeMs,undefined);
 }finally{service.stop();j.close();}
});

test('successive changed listings finish the unread tail without re-reading the same completed head',async()=>{
 const j=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},journal:j,policy:{shopId:'900001'}}),now=Date.now(),seen=new Map();
 let campaigns=Array.from({length:18},(_,i)=>({id:String(400001+i),name:'活动'+i,status:'进行中',type:'限时抢购',startAt:now-i*1000,endAt:now+86400000, risk:false}));
 platform.listActive=async()=>({complete:true,observedAt:Date.now(),campaigns:structuredClone(campaigns)});
 platform.detail=async c=>{seen.set(c.id,(seen.get(c.id)||0)+1);return{complete:true,observedAt:Date.now(),rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},products:[{productId:String(Number(c.id)+100000),name:c.name,skus:[{id:String(Number(c.id)+200000),name:'规格',baseFen:10000,discount:50}]}]};};
 let interrupted=0;
 try{
  for(let attempt=0;attempt<3;attempt++){
   const result=await platform.discover({historyReadLimit:0,...(attempt?{readOnlyReuseMaxAgeMs:900000}:{}),onReadBoundary:async({reads})=>{
    if(reads.length&&interrupted<2){interrupted++;campaigns=campaigns.slice(0,-1);return{refreshRequired:true,listing:await platform.listActive()};}
   }});
   if(attempt<2)assert.equal(result.priorityRefreshRequired,true);else{assert.equal(result.activeComplete,true);assert.equal(result.baselines.length,16);}
  }
  assert.equal(seen.size,16);assert.ok([...seen.values()].every(count=>count===1),'Completed unchanged activities must not monopolize each resumed pass');
 }finally{j.close();}
});

test('reused older positive observations remain hints and cannot end a price/recovery check as freshly active',async()=>{
 const j=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},journal:j,policy:{shopId:'900001'}}),now=Date.now();
 const baseline={shopId:'900001',productId:'300001',campaignId:'400001',type:'限时抢购'};
 platform.inventory={readOnlyReuseMaxAgeMs:900000,activeComplete:true,listing:{complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'}]},
  details:new Map([['400001',{complete:true,observedAt:now-180000,products:[{productId:'300001',removalConfirmed:false,removalAmbiguous:false}]}]])};
 try{const loss=await platform.loss(baseline);assert.equal(loss.complete,false);assert.equal(loss.activeHint,true);assert.equal(loss.active,undefined);}
 finally{j.close();}
});

test('fresh reused observations preserve their actual observation time',async()=>{
 const j=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},journal:j,policy:{shopId:'900001'}}),now=Date.now();
 platform.inventory={readOnlyReuseMaxAgeMs:900000,activeComplete:true,listing:{complete:true,observedAt:now-1000,campaigns:[{id:'400001',status:'进行中'}]},details:new Map([['400001',{complete:true,observedAt:now-2000,products:[{productId:'300001',removalConfirmed:false,removalAmbiguous:false}]}]])};
 try{const loss=await platform.loss({productId:'300001'});assert.equal(loss.complete,true);assert.equal(loss.active,true);assert.equal(loss.observedAt,now-2000);}finally{j.close();}
});

test('older reused absence evidence only requests a new scoped read and cannot enqueue a restoration',async()=>{
 const j=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},journal:j,policy:{shopId:'900001'}}),now=Date.now();
 platform.inventory={readOnlyReuseMaxAgeMs:900000,activeComplete:true,listing:{complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'}]},details:new Map([['400001',{complete:true,observedAt:now-180000,products:[]}]])};
 platform.limitedReference=()=>({campaignId:'400009',limited:false});
 try{await assert.rejects(platform.loss({productId:'300001',campaignId:'400009'}),error=>error.code==='LOSS_EVIDENCE_EXPIRED'&&error.detail.productId==='300001'&&error.detail.campaignId==='400009');assert.equal(j.list('900001').length,0);}finally{j.close();}
});
