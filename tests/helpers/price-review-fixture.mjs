import {planOriginalRestore} from '../../src/policy.mjs';
export const fixedNow=1792407698000;
export function priceFixture(journal,now=fixedNow){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'3000000000000000001',name:'价格确认测试商品',campaignId:'4000000000000000001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},
  skus:[{id:'5000000000000000001',name:'规格甲',baseFen:13900,discount:50},{id:'5000000000000000002',name:'规格乙',baseFen:10000,discount:60}]};
 const policy={shopId:baseline.shopId,allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 const current={shopId:baseline.shopId,productId:baseline.productId,observedAt:now,complete:true,skus:structuredClone(baseline.skus)};
 const plan=planOriginalRestore(baseline,current,policy,now);journal.remember(baseline,now);
 const task=journal.enqueue(baseline.shopId,[plan],{complete:true,lossKey:'price-fixture',observedAt:now},now);
 const probe={source:'live-platform-draft',kind:'draft',shopId:task.shopId,title:task.title,complete:true,observedAt:now,type:plan.type,rules:plan.rules,
  startAt:now,endAt:now+48*3600000,dialogs:[],warnings:['活动价不得高于近15天最低价（68元）'],
  rows:plan.skus.map((s,i)=>({...s,productId:plan.productId,errors:i===0?['活动价不得高于近15天最低价（68元）']:[]}))};
 return {baseline,current,policy,plan,task,probe};
}
