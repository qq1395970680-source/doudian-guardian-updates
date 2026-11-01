import test from 'node:test';
import assert from 'node:assert/strict';
import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';
import {seedLimitedRejection} from './helpers/activity-price-fixture.mjs';
import {blockerPriceOptions,activityPriceBasis} from '../src/activity-price-comparison.mjs';
import {activeOriginalPriceRecoveryGrant} from '../src/original-price-recovery-policy.mjs';

for(const mode of ['option','manual','changed-basis','expired-basis','unapproved-type'])test('independent typed price constraints and exact approval: '+mode,async()=>{
 const x=await blockerFixture();try{
  const other=seedLimitedRejection(x.journal,x.f,x.review);
  const view=await(await fetch(x.app.url+'/api/recovery-blockers/prices?productId='+x.review.productId)).json();
  const timed=view.comparison.find(c=>c.type==='限时抢购'),limited=view.comparison.find(c=>c.type==='限量抢购');
  assert.match(timed.reason,/68/);assert.match(limited.reason,/72/);assert.equal(timed.rows[0].saleFen,6672);assert.equal(limited.rows[0].saleFen,7228);
  assert.equal(timed.rows[0].bounds.maxFen,6800);assert.equal(limited.rows[0].bounds.minFen,7200);assert.equal(limited.rows[0].bounds.maxFen,undefined);
  assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.deepEqual(view.review.manualTypes,['限时抢购','限量抢购']);
  const option=view.review.options.find(o=>o.id===limited.optionId),base={shopId:x.review.shopId,reviewId:x.review.id,key:x.review.key};
  const args={...base,decision:'approve',acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:x.review.rows.map(r=>r.id),optionId:option.id,optionKey:option.key};
  if(mode==='manual'||mode==='unapproved-type'){
   const discounts=x.review.rows.map((r,i)=>({id:r.id,discount:i===0?53:60}));
   const preview=await x.post('recovery-blockers/prices/preview',{...base,activityType:'限量抢购',discounts});assert.equal(preview.status,200,await preview.clone().text());const chosen=(await preview.json()).option;
   args.optionId=chosen.id;args.optionKey=chosen.key;args.manualDiscounts=discounts;args.manualActivityType=mode==='unapproved-type'?'限时抢购':'限量抢购';
  }
  if(mode==='changed-basis'){other.rows[0].bounds.minFen=7300;x.journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(other),other.id);}
  if(mode==='expired-basis'){other.expiresAt=Date.now()-1;x.journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(other),other.id);}
  const result=await x.post('recovery-blockers/prices/decide',args),body=await result.json(),accepted=['option','manual'].includes(mode);assert.equal(result.status,accepted?200:400,JSON.stringify(body));
  if(accepted){const target=x.journal.priceTarget(x.review.shopId,x.review.productId);assert.equal(target.type,'限量抢购');assert.equal(target.rows[0].discount,mode==='manual'?53:52);const plan=x.service.restorePlan(x.f.baseline,{...x.f.current,observedAt:Date.now()});assert.equal(plan.type,'限量抢购');x.journal.assertPricePlans(x.review.shopId,[plan]);assert.equal(activeOriginalPriceRecoveryGrant(x.journal,x.review.shopId).key,x.grant.key);}
  else assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
 }finally{await x.close();}
});

for(const change of ['expiry','history','base','sku','previous-price','cross-shop','submitted','unproven-type'])test('other type needs its own matching fresh evidence: '+change,async()=>{
 const x=await blockerFixture();try{
  const r=seedLimitedRejection(x.journal,x.f,x.review);
  if(change==='expiry')r.expiresAt=Date.now()-1;
  if(change==='history')r.historicalFingerprint='other-history';
  if(change==='base')r.rows[0].baseFen++;
  if(change==='sku')r.rows.pop();
  if(change==='previous-price'){r.rows[0].previousDiscount=49;r.rows[0].previousFen=6811;}
  if(change==='cross-shop')r.shopId='900002';
  if(change==='submitted'){const row=x.journal.get(r.taskId);x.journal.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...row,submitAttempts:1}),r.taskId);}
  if(change==='unproven-type')r.type='限时抢购';
  x.journal.db.prepare('UPDATE price_reviews SET body=?,shop=? WHERE id=?').run(JSON.stringify(r),r.shopId,r.id);
  const context={reviews:x.journal.priceReviews(x.review.shopId),tasks:x.journal.list(x.review.shopId)};
  const options=blockerPriceOptions(x.review,context);assert.ok(!options.some(o=>o.id.startsWith('activity-limited-')));
  assert.throws(()=>activityPriceBasis(x.review,'限量抢购',context),{code:'PRICE_BASIS_REQUIRED'});
 }finally{await x.close();}
});

test('non-price read failures and unknown submissions are explained without pretending both platform types rejected prices',async()=>{
 const x=await blockerFixture();try{
  const task=x.journal.get(x.f.task.id);x.journal.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify({...task,reason:'LOAD_TIMEOUT: 页面读取超时'}),Date.now(),task.id);
  const view=await(await fetch(x.app.url+'/api/recovery-blockers/prices?productId='+x.review.productId)).json();const timed=view.comparison.find(c=>c.type==='限时抢购');assert.equal(timed.rejectionState,'check-blocked');assert.match(timed.reason,/页面读取超时/);assert.equal(view.comparison.find(c=>c.type==='限量抢购').rejectionState,'unverified');
 }finally{await x.close();}
});
