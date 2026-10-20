import {planOriginalRestore} from '../../src/policy.mjs';

export const ratioNow=1792495000000;
export function ratioFixture(journal,{now=ratioNow,mixed=false}={}){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',
  name:'倍率限制测试商品',campaignId:'400001',type:'限量抢购',activityLimit:1000,durationMs:7*86400000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
  skus:[{id:'500001',name:'小规格',baseFen:mixed?4700:10000,discount:50},
   {id:'500002',name:'大规格',baseFen:mixed?50300:50000,discount:50}]};
 const policy={shopId:baseline.shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true,
  liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 const current={...structuredClone(baseline),observedAt:now};
 const removal={productId:baseline.productId,name:baseline.name,
  reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'};
 const loss={complete:true,active:false,observedAt:now,lossKey:'ratio-loss',removal,
  removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:baseline.shopId,
   campaignId:baseline.campaignId,observedAt:now,sha256:'a'.repeat(64),record:structuredClone(removal)}};
 journal.remember(baseline,now);
 return {baseline,policy,current,loss,plan:planOriginalRestore(baseline,current,policy,now)};
}
