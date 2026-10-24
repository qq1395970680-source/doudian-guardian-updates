import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';

function setup(){
 const now=Date.now(),baseline={shopId:'900001',productId:'300001',campaignId:'400001',type:'限量抢购',historyAt:now-8*86400000,
  rules:{autoRenew:true},durationMs:7*86400000,activityLimit:1000};
 const current={id:'400002',name:'守护2-latest',type:'限时抢购',status:'已失效',risk:true,startAt:now-60000,endAt:now+172740000};
 const plan={...baseline,type:'限时抢购',durationMs:172800000,rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30}};
 const task={phase:'verified',title:current.name,plans:[plan],receipt:{campaignId:current.id,verifiedAt:now-30000}};
 const platform=new DoudianPlatform({browser:{},policy:{shopId:baseline.shopId},journal:{list:()=>[task]}});
 const removal={productId:baseline.productId,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。\n该商品各SKU售卖价，最高价需在最低价的5.3倍以内，请修改后再提交。'};
 const detail={complete:true,observedAt:now,products:[{productId:baseline.productId,removalConfirmed:false}],
  removalExport:{source:'live-platform-removal-export',complete:true,shopId:baseline.shopId,campaignId:current.id,
   observedAt:now,sha256:'a'.repeat(64),records:[removal]}};
 const listing={complete:true,observedAt:now,campaigns:[current]};
 return{now,baseline,current,task,platform,removal,detail,listing};
}

test('latest timed invalid source keeps exact export ratio even while its old product row remains present',()=>{
 const f=setup(),loss=f.platform.lossFrom(f.baseline,f.listing,new Map([[f.current.id,f.detail]]),true,true);
 assert.equal(loss.active,false);assert.deepEqual(loss.removal,f.removal);
 assert.equal(loss.removalEvidence.activityType,'限时抢购');assert.equal(loss.removalEvidence.campaignId,f.current.id);
});

test('fresh timed loss follows the latest verified title when removed product search omits its source',async()=>{
 const f=setup(),queries=[],read=[];
 f.platform.list=async query=>{queries.push(query);return{...f.listing,campaigns:query.title?[f.current]:[]};};
 f.platform.detail=async c=>{read.push(c.id);return f.detail;};
 const loss=await f.platform.loss(f.baseline,{fresh:true});
 assert.deepEqual(queries,[{productId:f.baseline.productId},{title:f.task.title}]);assert.deepEqual(read,[f.current.id]);
 assert.equal(loss.removalEvidence.campaignId,f.current.id);
});

test('timed source omitted by routine current-only scan requests a bounded fresh read without sequential planning reads',async()=>{
 const f=setup();f.platform.inventory={activeComplete:true,listing:{...f.listing,campaigns:[]},details:new Map()};
 f.platform.list=async()=>assert.fail('Planning must defer to fresh lossBatch');
 await assert.rejects(()=>f.platform.loss(f.baseline),e=>e.code==='LOSS_EVIDENCE_EXPIRED'&&e.detail.productId===f.baseline.productId&&e.detail.campaignId===f.current.id);
});

for(const mode of ['wrong-shop','wrong-campaign','duplicate','stale','missing-export','bad-hash','stale-detail'])
test('invalid timed risk evidence never silently permits another old-price restoration: '+mode,()=>{
 const f=setup();
 if(mode==='wrong-shop')f.detail.removalExport.shopId='900002';
 if(mode==='wrong-campaign')f.detail.removalExport.campaignId='400009';
 if(mode==='duplicate')f.detail.removalExport.records.push(f.removal);
 if(mode==='stale')f.detail.removalExport.observedAt=f.now-120001;
 if(mode==='missing-export')delete f.detail.removalExport;
 if(mode==='bad-hash')f.detail.removalExport.sha256='wrong';
 if(mode==='stale-detail')f.detail.observedAt=f.now-120001;
 assert.throws(()=>f.platform.lossFrom(f.baseline,f.listing,new Map([[f.current.id,f.detail]]),true,true),e=>['TIMED_LOSS_UNPROVEN','LOSS_EVIDENCE_EXPIRED'].includes(e.code));
});

test('a current verified restoration is preserved without inheriting an older rejected ancestor ratio',async()=>{
 const f=setup(),older={...f.current,id:'400001'},valid={...f.current,status:'进行中',risk:false};
 const loss=f.platform.lossFrom(f.baseline,{...f.listing,campaigns:[older,valid]},new Map([[older.id,f.detail],[valid.id,{...f.detail,removalExport:undefined}]]),true,true);
 assert.equal(loss.active,true);assert.equal(loss.campaignId,valid.id);assert.equal(loss.removal,undefined);
 f.platform.list=async()=>({...f.listing,campaigns:[valid]});f.platform.detail=async()=>({...f.detail,removalExport:undefined});
 assert.equal((await f.platform.loss(f.baseline,{fresh:true})).active,true);
});

test('an older failed ancestor export is never attached to an unrelated latest timed source',()=>{
 const f=setup(),old={...f.current,id:f.baseline.campaignId},latest={...f.current,risk:false,status:'已结束',endAt:f.now-1000};
 const loss=f.platform.lossFrom(f.baseline,{...f.listing,campaigns:[old,latest]},new Map([[old.id,{...f.detail,removalExport:{...f.detail.removalExport,campaignId:old.id}}],
  [latest.id,{complete:true,observedAt:f.now,products:[]}]]),true,true);
 assert.equal(loss.active,false);assert.equal(loss.removal,undefined);
});
