import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {ratioFixture,ratioNow} from './helpers/ratio-review-fixture.mjs';
import {priceOptions} from '../src/price-options.mjs';
import {fingerprint} from '../src/policy.mjs';
import {activeOriginalPriceRecoveryGrant,setOriginalPriceRecoveryPolicy} from '../src/original-price-recovery-policy.mjs';

function fixture(){
 const j=new Journal(':memory:'),f=ratioFixture(j),r=j.recordRemovalPriceReview(f.plan,f.loss,ratioNow);
 j.putSettings('application',{accounts:[{shopId:f.policy.shopId,originalRiskAllowed:true}]});
 const option=priceOptions(r).find(o=>o.id==='switch-original');
 const previous=j.decidePriceReview(f.policy.shopId,r.id,r.key,'approve',{confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,
  historicalFingerprint:fingerprint(f.baseline),optionId:option.id,optionKey:option.key},ratioNow+1);
 let now=ratioNow+10;const service=new GuardianService({journal:j,platform:{},policy:f.policy,now:()=>now});
 const next=(campaignId,discount=40)=>{now+=10;const baseline={...structuredClone(f.baseline),campaignId,historyAt:now,skus:f.baseline.skus.map(s=>({...s,discount}))};j.remember(baseline,now);return{baseline,current:{...baseline,observedAt:now}};};
 const enable=()=>setOriginalPriceRecoveryPolicy(j,f.policy.shopId,{enabled:true,acceptOriginalPricesOnly:true},now);
 return{j,f,service,previous,next,enable,get now(){return now;}};
}
test('repeat removals reuse only the same previously approved exact prices under explicit shop policy',()=>{
 const x=fixture();try{
  const first=x.next('400002');assert.throws(()=>x.service.restorePlan(first.baseline,first.current),{code:'PRICE_RECONFIRM_REQUIRED'});
  x.enable();const plan=x.service.restorePlan(first.baseline,first.current);assert.equal(plan.type,'限时抢购');assert.ok(plan.skus.every(s=>s.discount===50));
  const target=x.j.priceTarget(x.f.policy.shopId,plan.productId);assert.equal(target.approvalKind,'original-price-continuity');assert.equal(target.consent,undefined);
  assert.deepEqual(target.rows.map(r=>r.saleFen),x.previous.rows.map(r=>r.saleFen));x.j.assertPricePlans(x.f.policy.shopId,[plan]);
  const second=x.next('400003',35),again=x.service.restorePlan(second.baseline,second.current);x.j.assertPricePlans(x.f.policy.shopId,[again]);
  assert.ok(again.skus.every(s=>s.discount===50));assert.equal(x.j.priceReviews(x.f.policy.shopId).filter(r=>r.status==='pending').length,0);
  assert.equal(x.j.priceReview(x.previous.id).status,'approved');assert.equal(x.j.list(x.f.policy.shopId).length,0);
 }finally{x.j.close();}
});
test('original-only policy rejects new bases, changed SKU sets and unknown submissions',()=>{
 for(const change of ['base','sku','unknown']){const x=fixture();try{
  x.enable();const {baseline,current}=x.next('400004');
  if(change==='base'){baseline.skus[0].baseFen+=100;current.skus[0].baseFen+=100;x.j.remember(baseline,x.now);}
  if(change==='sku'){baseline.skus.push({id:'500003',name:'新增规格',baseFen:10000,discount:40});current.skus=structuredClone(baseline.skus);x.j.remember(baseline,x.now);}
  if(change==='unknown')x.j.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('existing',x.f.policy.shopId,'unknown-fixture','unknown',JSON.stringify({plans:[x.f.plan],submitAttempts:1,riskAttempts:0}),x.now);
  assert.throws(()=>x.service.restorePlan(baseline,current));assert.equal(x.j.priceTarget(x.f.policy.shopId,baseline.productId).id,x.previous.id);
 }finally{x.j.close();}}
});
test('original-only consent is shop scoped and required; stopped policy keeps existing exact price audit',()=>{
 const x=fixture();try{
  assert.throws(()=>setOriginalPriceRecoveryPolicy(x.j,x.f.policy.shopId,{enabled:true},x.now),{code:'ORIGINAL_PRICE_CONSENT_REQUIRED'});
  assert.equal(activeOriginalPriceRecoveryGrant(x.j,x.f.policy.shopId,x.now),null);x.enable();assert.equal(activeOriginalPriceRecoveryGrant(x.j,'900002',x.now),null);
  const next=x.next('400005'),plan=x.service.restorePlan(next.baseline,next.current);setOriginalPriceRecoveryPolicy(x.j,x.f.policy.shopId,{enabled:false},x.now);
  assert.equal(activeOriginalPriceRecoveryGrant(x.j,x.f.policy.shopId,x.now),null);x.j.assertPricePlans(x.f.policy.shopId,[plan]);
  const later=x.next('400006');assert.throws(()=>x.service.restorePlan(later.baseline,later.current),{code:'PRICE_RECONFIRM_REQUIRED'});
 }finally{x.j.close();}
});
