import test from 'node:test';
import assert from 'node:assert/strict';
import {planOriginalRestore,restorationGroupKey,proveDraft,proveReadback,fingerprint} from '../src/policy.mjs';
import {GuardianService} from '../src/service.mjs';
import {Journal} from '../src/journal.mjs';
const now=Date.now(),policy={shopId:'900001',originalRiskAllowed:true};
function baseline(type,durationMs){return {source:'verified-platform-history',complete:true,shopId:'900001',productId:'3849118543765439254',name:'时长测试',type,durationMs,
 rules:{noLimit:type!=='限量抢购',noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(type==='限量抢购'?{autoRenew:true}:{})},activityLimit:1000,
 skus:[{id:'500000000000000001',name:'规格',baseFen:10000,discount:60}]};}
for(const type of ['限量抢购','限时抢购'])test(`${type} preserves seconds, separates duration groups, and rejects one-second draft/readback drift`,()=>{
 const b=baseline(type,2419207000),plan=planOriginalRestore(b,{...b,observedAt:now},policy,now);
 assert.equal(plan.durationMs,2419207000);
 assert.notEqual(restorationGroupKey(plan),restorationGroupKey({...plan,durationMs:28*86400000}));
 const o={kind:'draft',title:'测试',complete:true,shopId:policy.shopId,observedAt:now,startAt:now,endAt:now+plan.durationMs,type,rules:b.rules,rows:plan.skus.map(s=>({...s,productId:b.productId})),warnings:[],dialogs:[],productLimits:[{productId:b.productId,activityLimit:1000}],status:'进行中',campaignId:'400000000000000001'};
 const task={id:'test',title:o.title,shopId:policy.shopId,plans:[plan]};
 assert.ok(proveDraft(task,o,now));assert.equal(proveReadback([plan],o,{now}).durationMs,plan.durationMs);
 assert.throws(()=>proveDraft(task,{...o,endAt:o.endAt-1000},now),{code:'DRAFT_TIME'});
 assert.throws(()=>proveReadback([plan],{...o,endAt:o.endAt+1000},{now}),{code:'LIMITED_READBACK'});
  assert.throws(()=>proveReadback([plan],{...o,startAt:o.startAt+1000,endAt:o.endAt+1000},{now,expectedRange:o}),{code:'DRAFT_TIME_READBACK'});
 for(const duration of [NaN,0,-1000,2419207001])assert.throws(()=>planOriginalRestore(baseline(type,duration),{...b,observedAt:now},policy,now));
});
test('duration enrichment preserves exact prior price consent and confirmed campaign choice',()=>{
 const j=new Journal(':memory:');try{
  const old=baseline('限时抢购',undefined);delete old.durationMs;old.campaignId='400000001';
  j.remember(old);const next={...old,durationMs:2419207000};j.remember(next);
  const review={id:'approval',key:'exact',status:'approved',shopId:policy.shopId,productId:old.productId,historicalFingerprint:fingerprint(old),consent:{exactPrices:true},rows:[{id:old.skus[0].id,name:'规格',baseFen:10000,historicalDiscount:60,discount:65,saleFen:6500}]};
  j.priceTarget=()=>review;
  const s=new GuardianService({journal:j,platform:{},policy,now:()=>now});
  const plan=s.restorePlan(next,{...next,observedAt:now});
  assert.equal(plan.priceApprovalId,review.id);assert.equal(plan.historicalFingerprint,review.historicalFingerprint);assert.equal(plan.skus[0].saleFen,6500);assert.equal(plan.durationMs,2419207000);
  review.campaignTarget={type:'限时抢购',activityLimit:null,durationMs:48*3600000,rules:old.rules};
  const choice=s.restorePlan(next,{...next,observedAt:now});assert.equal(choice.durationMs,48*3600000);assert.equal(choice.skus[0].saleFen,6500);
  const changed={...next,campaignId:'400000002'};assert.throws(()=>s.restorePlan(changed,{...changed,observedAt:now}),{code:'CAMPAIGN_CHOICE_CHANGED'});
 }finally{j.close();}
});
