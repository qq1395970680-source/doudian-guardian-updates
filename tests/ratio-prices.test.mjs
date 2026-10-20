import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint,saleFen} from '../src/policy.mjs';
import {isAutomaticPriceIncrease} from '../src/price-increase-policy.mjs';
import {selectRatioPrices,makeRemovalPriceReview} from '../src/ratio-prices.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';

const consent=r=>({confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint});
function score(skus,rows){
 const deltas=rows.map((r,i)=>r.saleFen-skus[i].saleFen);
 return [Number(deltas.some(d=>d<0)),deltas.reduce((n,d)=>n+Math.abs(d),0),deltas.reduce((n,d)=>n+Math.max(0,-d),0),
  rows.reduce((n,r,i)=>n+Math.abs(r.discount-skus[i].discount),0),rows.filter((r,i)=>r.discount!==skus[i].discount).length];
}
const compare=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]-b[i];}return 0;};

test('ratio optimizer agrees with exhaustive two-SKU search including cent rounding, equal ratios and fractional ratios',()=>{
 for(const [bases,discounts,n,d] of [
  [[4700,50300],[50,50],35,10],[[10000,50000],[50,50],35,10],
  [[3,17],[40,60],1,1],[[51,101],[50,60],15,10],[[9999,33333],[23,71],53,10],
  [[20000,10000],[20,90],1,1],[[47,503],[95,10],3501,1000]
 ]){
  const skus=bases.map((baseFen,i)=>({id:String(i),baseFen,discount:discounts[i],saleFen:saleFen(baseFen,discounts[i])}));
  let best=null;
  for(let a=10;a<=95;a++)for(let b=10;b<=95;b++){
   const rows=[a,b].map((discount,i)=>({discount,saleFen:saleFen(bases[i],discount)}));
   const prices=rows.map(r=>r.saleFen);
   if(Math.min(...prices)<=0||Math.max(...prices)*d>Math.min(...prices)*n)continue;
   const value=score(skus,rows);if(!best||compare(value,best)<0)best=value;
  }
  if(!best)assert.throws(()=>selectRatioPrices(skus,{numerator:n,denominator:d}),{code:'NO_FEASIBLE_PRICE'});
  else assert.deepEqual(score(skus,selectRatioPrices(skus,{numerator:n,denominator:d})),best);
 }
});

test('500 SKU proposal remains bounded and satisfies exact integer ratio',()=>{
 const skus=Array.from({length:500},(_,i)=>({id:String(i),baseFen:10000+i*97,discount:50,saleFen:saleFen(10000+i*97,50)}));
 const rows=selectRatioPrices(skus,{numerator:35,denominator:10}),prices=rows.map(r=>r.saleFen);
 assert.equal(rows.length,500);assert.ok(Math.max(...prices)*10<=Math.min(...prices)*35);
 assert.ok(rows.every((r,i)=>r.saleFen>=skus[i].saleFen));
});

for(const change of ['diagnostic','wrong-shop','wrong-product','expired-export','future-export','incomplete','active','wrong-record','bad-hash','stale-plan','changed-plan'])
test('ratio proposal requires fresh matching direct evidence: '+change,()=>{
 const j=new Journal(':memory:');try{
  const f=ratioFixture(j);
  if(change==='diagnostic')f.loss.removalEvidence.source='local-diagnostic-export';
  if(change==='wrong-shop')f.loss.removalEvidence.shopId='900002';
  if(change==='wrong-product')f.loss.removal.productId='300002';
  if(change==='expired-export')f.loss.removalEvidence.observedAt=now-120001;
  if(change==='future-export')f.loss.removalEvidence.observedAt=now+5001;
  if(change==='incomplete')f.loss.complete=false;
  if(change==='active')f.loss.active=true;
  if(change==='wrong-record')f.loss.removalEvidence.record.reason='changed';
  if(change==='bad-hash')f.loss.removalEvidence.sha256='unknown';
  if(change==='stale-plan')f.plan.observedAt=now-120001;
  if(change==='changed-plan')f.plan.skus[0].discount=49;
  assert.throws(()=>makeRemovalPriceReview(f.plan,f.loss,now),{code:'PRICE_REVIEW_EVIDENCE'});
  assert.equal(j.priceReviews(f.policy.shopId).length,0);
 }finally{j.close();}
});

test('direct ratio reviews stay pending, deduplicate and allow explicit recalculation without a submit task',()=>{
 const j=new Journal(':memory:');try{
  const f=ratioFixture(j),r=j.recordRemovalPriceReview(f.plan,f.loss,now);
  assert.equal(isAutomaticPriceIncrease(r),false);
  assert.equal(j.recordRemovalPriceReview(f.plan,f.loss,now+1).id,r.id);
  j.decidePriceReview(r.shopId,r.id,r.key,'decline',{},now+2);
  assert.equal(j.recordRemovalPriceReview(f.plan,f.loss,now+3).status,'declined');
  j.decidePriceReview(r.shopId,r.id,r.key,'recalculate',{},now+4);
  const next=j.recordRemovalPriceReview(f.plan,f.loss,now+5);assert.notEqual(next.id,r.id);
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+6));
  assert.equal(j.list(r.shopId).length,0);
  j.decidePriceReview(next.shopId,next.id,next.key,'approve',consent(next),now+7);
  assert.equal(j.priceTarget(next.shopId,next.productId).id,next.id);
 }finally{j.close();}
});

test('ratio proposal rejects a forged original price and unresolved task even with refreshed fingerprints',()=>{
 const j=new Journal(':memory:');try{
  const f=ratioFixture(j),changed=structuredClone(f.plan);
  changed.skus[0].discount=40;changed.skus[0].saleFen=4000;
  const {fingerprint:ignored,...material}=changed;changed.fingerprint=fingerprint(material);
  assert.throws(()=>j.recordRemovalPriceReview(changed,f.loss,now),{code:'PRICE_REVIEW_CHANGED'});
  j.enqueue(f.policy.shopId,[f.plan],{complete:true,observedAt:now,lossKey:'unresolved'},now);
  assert.throws(()=>j.recordRemovalPriceReview(f.plan,f.loss,now),{code:'PENDING'});
 }finally{j.close();}
});
