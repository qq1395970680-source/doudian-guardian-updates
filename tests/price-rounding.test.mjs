import test from 'node:test';
import assert from 'node:assert/strict';
import {saleFen,planOriginalRestore,proveDraft,proveReadback,fingerprint} from '../src/policy.mjs';
import {selectRatioPrices} from '../src/ratio-prices.mjs';
import {selectClosestPriceStep,applyPriceTarget} from '../src/price-review.mjs';
import {Journal} from '../src/journal.mjs';
import {priceOptions} from '../src/price-options.mjs';
const now=1792407698000;
const oracle=(base,discount)=>Number((BigInt(base)*BigInt(discount)+99n)/100n);
function fixture(){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'3849118543765439254',name:'取整测试',campaignId:'4000000000000000001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'3386359933583653',name:'规格甲',baseFen:6875,discount:95}]};
 const current={shopId:baseline.shopId,productId:baseline.productId,complete:true,observedAt:now,skus:structuredClone(baseline.skus)};
 const policy={shopId:baseline.shopId,originalRiskAllowed:true};
 const plan=planOriginalRestore(baseline,current,policy,now),task={id:'test',shopId:plan.shopId,title:'test',plans:[plan]};
 const observation={kind:'draft',title:'test',shopId:plan.shopId,complete:true,observedAt:now,type:plan.type,rules:plan.rules,startAt:now,endAt:now+172800000,warnings:[],dialogs:[],rows:plan.skus.map(s=>({...s,productId:plan.productId,saleFen:6532,saleSource:'observed'}))};
 return {baseline,current,policy,plan,task,observation};
}
test('platform amount rounds upward to fen: reported SKU and independent integer oracle',()=>{
 assert.equal(saleFen(6875,95),6532);
 for(const base of [1,3,51,101,6875,9999,10000,100000000])for(let d=10;d<=99;d++)assert.equal(saleFen(base,d),oracle(base,d),`${base} ${d}`);
});
test('draft and independent receipt require exact 6532, never a one-fen tolerance',()=>{
 const {task,observation}=fixture();assert.equal(task.plans[0].skus[0].saleFen,6532);
 assert.ok(proveDraft(task,observation,now));
 const live={...observation,status:'进行中',campaignId:'4000000000000000002'};
 assert.ok(proveReadback(task.plans,live,{now}));
 for(const amount of [6531,6533]){
  const wrong=structuredClone(observation);wrong.rows[0].saleFen=amount;
  assert.throws(()=>proveDraft(task,wrong,now),{code:'DRAFT_PRICE'});
  assert.throws(()=>proveReadback(task.plans,{...live,rows:wrong.rows},{now}),{code:'READBACK_PRICE'});
 }
});
test('price step and 3.5 ratio inclusive boundaries use the same upward fen amounts',()=>{
 const sku={id:'123',baseFen:6875,discount:95,saleFen:6532};
 assert.equal(selectClosestPriceStep(sku,{minFen:6532,maxFen:6532}).saleFen,6532);
 assert.deepEqual(selectRatioPrices([sku],{numerator:35,denominator:10},[{minFen:6532,maxFen:6532}]),[{discount:95,saleFen:6532}]);
 assert.throws(()=>selectRatioPrices([sku],{numerator:35,denominator:10},[{minFen:6531,maxFen:6531}]),{code:'NO_FEASIBLE_PRICE'});
 const skus=[{id:'123',baseFen:101,discount:50,saleFen:51},{id:'456',baseFen:357,discount:50,saleFen:179}];
 const rows=selectRatioPrices(skus,{numerator:7,denominator:2});
 assert.ok(Math.max(...rows.map(s=>s.saleFen))*2<=Math.min(...rows.map(s=>s.saleFen))*7);
 assert.ok(rows.every((s,i)=>s.saleFen>=skus[i].saleFen));
});
test('old exact approval must not silently become a different approved fen amount',()=>{
 const {baseline,plan}=fixture(),j=new Journal(':memory:');
 try{
  j.remember(baseline,now);
  const review={id:'old-approval',shopId:plan.shopId,productId:plan.productId,status:'approved',key:'old-key',historicalFingerprint:fingerprint(baseline),consent:{exactPrices:true,matchedRiskConfirmation:true},rows:[{...plan.skus[0],historicalDiscount:95,saleFen:6531}]};
  j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(review.id,review.shopId,review.productId,review.status,JSON.stringify(review),now);
  j.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(review.shopId,review.productId,review.id);
  assert.throws(()=>applyPriceTarget(plan,review),{code:'PRICE_APPROVAL_CHANGED'});
  for(const value of [6531,6532]){
   const changed={...plan,priceApprovalId:review.id,priceApprovalKey:review.key,skus:[{...plan.skus[0],saleFen:value}]};
   assert.throws(()=>j.assertPricePlans(plan.shopId,[changed]),{code:'PRICE_APPROVAL_CHANGED'});
  }
  assert.equal(j.priceReview(review.id).rows[0].saleFen,6531);
 }finally{j.close();}
});
test('stale pending prices cannot be approved or displayed as an executable option',()=>{
 const {plan}=fixture(),j=new Journal(':memory:');
 try{
  const r={id:'old-pending',shopId:plan.shopId,productId:plan.productId,status:'pending',key:'old-key',historicalFingerprint:plan.historicalFingerprint,type:plan.type,createdAt:now,expiresAt:now+60000,rows:[{...plan.skus[0],historicalDiscount:95,previousDiscount:95,previousFen:6531,saleFen:6531}]};
  j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(r.id,r.shopId,r.productId,r.status,JSON.stringify(r),now);
  assert.ok(priceOptions(r).every(o=>!o.available&&o.reason.includes('重新计算')));
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',{confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint},now),{code:'PRICE_REVIEW_CHANGED'});
  assert.equal(j.priceReview(r.id).status,'pending');
 }finally{j.close();}
});
test('a corrected rounded price never allows replay of an unknown old submission',()=>{
 const {plan}=fixture(),j=new Journal(':memory:');
 try{
  const old=structuredClone(plan);old.skus[0].saleFen=6531;
  const loss={complete:true,observedAt:now,lossKey:'same-removal'};
  const task=j.enqueue(plan.shopId,[old],loss,now);
  j.transition(task.id,'queued','prepared',{},now);j.transition(task.id,'prepared','submitting',{submitAttempts:1},now);
  j.recoverInterrupted(plan.shopId);
  assert.equal(j.get(task.id).phase,'unknown');
  assert.throws(()=>j.enqueue(plan.shopId,[plan],loss,now),{code:'PENDING'});
  assert.equal(j.get(task.id).plans[0].skus[0].saleFen,6531);assert.equal(j.list(plan.shopId).length,1);
 }finally{j.close();}
});
