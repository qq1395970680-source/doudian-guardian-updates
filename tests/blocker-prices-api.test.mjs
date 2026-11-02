import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {makePriceReviews} from '../src/price-review.mjs';
import {manualPriceOption} from '../src/manual-price-option.mjs';
import {priceFixture} from './helpers/price-review-fixture.mjs';
import {activeOriginalPriceRecoveryGrant,setOriginalPriceRecoveryPolicy} from '../src/original-price-recovery-policy.mjs';

import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';

for(const mode of ['correct','no-consent','wrong-key','missing-sku','duplicate-sku','unknown-sku','invalid-step','cap','wrong-option','unknown-task','expired','history','excluded','old-route','no-preview','read-only'])test('blocker exact-price API '+mode,async()=>{
 const x=await blockerFixture(),{app,journal,review,f,post}=x;
 try{
  const list=await(await fetch(app.url+'/api/price-reviews')).json();assert.equal(list.pending,0);
  const view=await(await fetch(app.url+'/api/recovery-blockers/prices?productId='+review.productId)).json();assert.equal(view.review.id,review.id);assert.equal(view.review.manualEditable,true);
  const discounts=review.rows.map((r,i)=>({id:r.id,discount:i===0?47:61})),base={shopId:review.shopId,reviewId:review.id,key:review.key};
  if(mode==='read-only'){assert.equal(journal.priceTarget(review.shopId,review.productId),null);return;}
  const initial=await post('recovery-blockers/prices/preview',{...base,discounts});assert.equal(initial.status,200,await initial.clone().text());const option=(await initial.json()).option;
  assert.equal(journal.priceTarget(review.shopId,review.productId),null,'preview never approves or enqueues');assert.equal(journal.list(review.shopId).length,1);
  const args={...base,decision:'approve',acceptBlockedPriceChange:true,acceptPriceAndRisk:true,confirmedSkuIds:review.rows.map(r=>r.id),optionId:option.id,optionKey:option.key,manualDiscounts:discounts};
  if(mode==='no-consent')args.acceptBlockedPriceChange=false;
  if(mode==='old-route')delete args.acceptBlockedPriceChange; // Legacy clients did not opt into the single-product exception.
  if(mode==='wrong-key')args.key='stale';
  if(mode==='missing-sku')args.manualDiscounts.pop();
  if(mode==='duplicate-sku')args.manualDiscounts[1].id=args.manualDiscounts[0].id;
  if(mode==='unknown-sku')args.manualDiscounts[1].id='other';
  if(mode==='invalid-step')args.manualDiscounts[0].discount=47.1;
  if(mode==='cap')args.manualDiscounts[0].discount=49;
  if(mode==='wrong-option')args.optionKey='changed';
  if(mode==='unknown-task')journal.enqueue(review.shopId,[f.plan],{complete:true,lossKey:'unknown',observedAt:Date.now()},Date.now());
  if(mode==='expired'){const old={...review,expiresAt:Date.now()-1};journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(old),review.id);}
  if(mode==='history')journal.remember({...f.baseline,campaignId:'4000000000000000099'},Date.now());
  if(mode==='excluded')f.policy.excludedProductIds.push(review.productId);
  if(mode==='no-preview')args.manualDiscounts[1].discount=62;
  const result=await post(mode==='old-route'?'price-reviews/decide':'recovery-blockers/prices/decide',args),body=await result.json();
  assert.equal(result.status,mode==='correct'?200:400,JSON.stringify(body));
  const target=journal.priceTarget(review.shopId,review.productId);
  if(mode==='correct'){assert.equal(target.approvalContext,'recovery-blockers');assert.deepEqual(target.rows.map(r=>r.discount),[47,61]);assert.equal(target.consent.exactPrices,true);assert.equal(activeOriginalPriceRecoveryGrant(journal,review.shopId).key,x.grant.key);assert.equal(journal.get(f.task.id).submitAttempts,0);}
  else assert.equal(target,null);
 }finally{await x.close();}
});

test('custom prices obey ratio constraints and special reconfirmations retain their exact-price path',()=>{
 const now=Date.now(),r={status:'pending',key:'key',createdAt:now-100,expiresAt:now+1000,ratio:{numerator:2,denominator:1},rows:[{id:'a',name:'甲',baseFen:10000,previousDiscount:50,previousFen:5000,discount:50,saleFen:5000},{id:'b',name:'乙',baseFen:10000,previousDiscount:50,previousFen:5000,discount:50,saleFen:5000}]};
 assert.throws(()=>manualPriceOption(r,[{id:'a',discount:20},{id:'b',discount:60}],now),{code:'NO_FEASIBLE_PRICE'});
 assert.throws(()=>manualPriceOption({...r,kind:'history-reconfirmation'},[{id:'a',discount:50},{id:'b',discount:50}],now),{code:'PRICE_REVIEW_CHANGED'});
});

test('expired declined suggestions stay hidden but can be explicitly recalculated from blockers',async()=>{
 const x=await blockerFixture();try{
  const r={...x.review,status:'declined',expiresAt:Date.now()-1};x.journal.db.prepare('UPDATE price_reviews SET state=?,body=? WHERE id=?').run(r.status,JSON.stringify(r),r.id);
  const view=await(await fetch(x.app.url+'/api/recovery-blockers/prices?productId='+r.productId)).json();assert.equal(view.review,null);assert.deepEqual(view.recheckReview,{id:r.id,key:r.key});
  const result=await x.post('recovery-blockers/prices/decide',{shopId:r.shopId,reviewId:view.recheckReview.id,key:view.recheckReview.key,decision:'recalculate'});assert.equal(result.status,200,await result.clone().text());assert.equal(x.journal.priceReview(r.id).status,'superseded');assert.equal(x.journal.priceTarget(r.shopId,r.productId),null);
 }finally{await x.close();}
});
