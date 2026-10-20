import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint,restorationGroupKey} from '../src/policy.mjs';
import {setCampaignPolicy} from '../src/campaign-policy.mjs';

const baseline=(shopId='900001',discount=60)=>({source:'verified-platform-history',complete:true,shopId,productId:'300001',campaignId:'400001',
 name:'现有商品',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},
 observedAt:Date.now(),historyAt:Date.now()-100000,skus:[{id:'500001',name:'规格甲',baseFen:10000,discount}]});
const target={type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}};

test('shop campaign policy preserves exact current prices and pins live source over older histories',()=>{
 const j=new Journal(':memory:');try{
  const older=baseline();older.historyAt-=100000;older.skus[0].discount=50;j.remember(older);
  const current=baseline();current.generatedByGuardian=true;j.remember(current);
  setCampaignPolicy(j,'900001',target,[current],{confirmed:true,source:'human-request',requestId:'conversion-1'});
  const service=new GuardianService({journal:j,platform:{},policy:{shopId:'900001',originalRiskAllowed:true}});
  assert.equal(fingerprint(service.latestHistories().get('300001')),fingerprint(current));
  const plan=service.restorePlan(current,{...current,observedAt:Date.now()});
  assert.equal(plan.type,'限量抢购');assert.equal(plan.activityLimit,1000);assert.equal(plan.skus[0].discount,60);
  assert.equal(plan.rules.autoRenew,true);j.assertPricePlans('900001',[plan]);
  const changed=structuredClone(plan);changed.activityLimit=999;assert.throws(()=>j.assertPricePlans('900001',[changed]),{code:'CAMPAIGN_POLICY_CHANGED'});
  assert.equal(j.histories('900001').length,2,'all original histories remain');
  assert.equal(new GuardianService({journal:j,platform:{},policy:{shopId:'900002'}}).latestHistories().size,0);
 }finally{j.close();}
});
test('campaign policy cannot take a diagnostic or another shop as its price source',()=>{
 const j=new Journal(':memory:');try{
  const b=baseline();j.remember(b);
  assert.throws(()=>setCampaignPolicy(j,'900002',target,[b],{confirmed:true,source:'human-request',requestId:'x'}));
  assert.throws(()=>setCampaignPolicy(j,'900001',target,[{...b,source:'diagnostic'}],{confirmed:true,source:'human-request',requestId:'x'}));
  assert.throws(()=>setCampaignPolicy(j,'900001',target,[b],{confirmed:false,source:'human-request',requestId:'x'}));
 }finally{j.close();}
});
test('limited grouping separates discounts and duration, preserves mixed SKU discounts as a group',()=>{
 const a={...target,skus:[{discount:50},{discount:60}]};
 assert.equal(restorationGroupKey(a),restorationGroupKey({...a,skus:[{discount:60},{discount:50}]}));
 assert.notEqual(restorationGroupKey(a),restorationGroupKey({...a,skus:[{discount:50}]}));
 assert.notEqual(restorationGroupKey(a),restorationGroupKey({...a,durationMs:86400000}));
});
test('re-reading unchanged live history binds the existing immutable record without losing freshness proof',()=>{
 const j=new Journal(':memory:');try{
  const saved=baseline();saved.observedAt-=3600000;j.remember(saved);
  const live={...saved,observedAt:Date.now()};j.remember(live);
  const p=setCampaignPolicy(j,'900001',target,[live],{confirmed:true,source:'human-request',requestId:'live-again'});
  assert.equal(p.preferredBaselines[saved.productId],fingerprint(saved));assert.equal(j.histories('900001').length,1);
 }finally{j.close();}
});
