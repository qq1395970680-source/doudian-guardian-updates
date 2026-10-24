import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
const setup=()=>{
 const now=Date.now(),baseline={shopId:'900001',productId:'300001',campaignId:'400001',type:'限量抢购',durationMs:7*86400000,activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}};
 const platform=new DoudianPlatform({browser:{},policy:{shopId:baseline.shopId}});
 const old={id:baseline.campaignId,name:'原活动',type:'限量抢购',status:'已结束',startAt:now-8*86400000,endAt:now-86400000,risk:false};
 const next={id:'400002',name:'原活动',type:'限量抢购',status:'进行中',startAt:now-86400000+1000,endAt:now+6*86400000+1000,risk:true};
 const product={productId:baseline.productId,soldOut:false,removalConfirmed:false,removalRiskConfirmed:false,removalAmbiguous:false,activityLimit:1000};
 const exported=c=>({source:'live-platform-removal-export',shopId:baseline.shopId,campaignId:c.id,complete:true,observedAt:now,sha256:'a'.repeat(64),
  records:[{productId:baseline.productId,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]});
 const detail=(products=[],removalExport=null)=>({complete:true,observedAt:now,products,rules:baseline.rules,...(removalExport?{removalExport}:{})});
 const listing=campaigns=>({complete:true,observedAt:now,campaigns});
 return{now,baseline,platform,old,next,product,exported,detail,listing};
};
test('a new current activity exact export identifies this product without guessing renewal by name',()=>{
 const f=setup(),listing=f.listing([f.next]),details=new Map([[f.next.id,f.detail([],f.exported(f.next))]]);
 const result=f.platform.lossFrom(f.baseline,listing,details,true,true);
 assert.equal(result.active,false);assert.equal(result.removalEvidence.campaignId,f.next.id);
 assert.equal(result.continuity.referenceCampaignId,f.next.id);
});
test('auto-renew history with a fresh exact ended risk export retains its price rule for review',()=>{
 const f=setup(),listing=f.listing([f.old]),details=new Map([[f.old.id,f.detail([],f.exported(f.old))]]);
 const result=f.platform.lossFrom(f.baseline,listing,details,true,true);
 assert.equal(result.active,false);assert.equal(result.removal.productId,f.baseline.productId);
 assert.equal(result.continuity.kind,'expired-risk-renewal');
});
test('verified natural expiry can renew an auto-renew member, independently of abnormal removal',()=>{
 const f=setup(),result=f.platform.lossFrom(f.baseline,f.listing([f.old]),new Map([[f.old.id,f.detail([f.product])]]),true,true);
 assert.equal(result.active,false);assert.equal(result.continuity.kind,'expired-renewal');assert.equal(result.removal,undefined);
});
for(const mode of ['sold-out','cancelled','no-auto-renew','no-member','ambiguous','wrong-shop','stale-export'])
test('limited continuity never turns unsupported state into restock permission: '+mode,()=>{
 const f=setup(),old={...f.old},baseline=structuredClone(f.baseline),product={...f.product};let products=[product],exp=null;
 if(mode==='sold-out'){product.soldOut=true;exp=f.exported(old);}
 if(mode==='cancelled')old.status='已作废';
 if(mode==='no-auto-renew')baseline.rules.autoRenew=false;
 if(mode==='no-member')products=[];
 if(mode==='ambiguous')product.removalAmbiguous=true;
 if(mode==='wrong-shop'){products=[];exp={...f.exported(old),shopId:'900002'};}
 if(mode==='stale-export'){products=[];exp={...f.exported(old),observedAt:f.now-120001};}
 assert.throws(()=>f.platform.lossFrom(baseline,f.listing([old]),new Map([[old.id,f.detail(products,exp)]]),true,true),e=>
  e.code==='LIMITED_LOSS_UNPROVEN'&&typeof e.detail?.limitedLoss?.branch==='string');
});
test('renewal origin absent from current inventory schedules a bounded shared re-read, not a per-product full list',async()=>{
 const f=setup();let calls=0;f.platform.inventory={activeComplete:true,listing:f.listing([]),details:new Map()};
 f.platform.list=async()=>{calls++;throw Error('must not launch a sequential planning read');};
 await assert.rejects(()=>f.platform.loss(f.baseline),e=>e.code==='LOSS_EVIDENCE_EXPIRED'&&e.detail.campaignId===f.old.id);
 assert.equal(calls,0);
});
