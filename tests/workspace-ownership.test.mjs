import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {workspaceOwnership} from '../src/workspace-ownership.mjs';
import {seedPriceQueue} from './helpers/large-price-queue-fixture.mjs';
import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';
import {makePriceReviews} from '../src/price-review.mjs';

test('fresh actionable proposals have one owner and stay reachable in original-price mode',async()=>{
 const x=await blockerFixture();try{
  const pending=await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json(),blockers=await(await fetch(x.app.url+'/api/recovery-blockers')).json();
  assert.equal(pending.pending,1);assert.equal(pending.total,1);assert.equal(pending.reviews[0].id,x.review.id);assert.equal(x.app.snapshot().priceReviewsPending,1);assert.equal(blockers.records.some(r=>r.productId===x.review.productId),false);assert.equal(x.app.snapshot().recoveryBlockersTotal,blockers.counts.total);
  const detail=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+x.review.productId)).json();assert.equal(detail.review.id,x.review.id);assert.equal(detail.blocked,false);assert.equal(detail.comparison.length,2);
  const legacy=await(await fetch(x.app.url+'/api/price-reviews')).json();assert.equal(legacy.pending,0,'omitted scope keeps beta.58 queue compatibility');
 }finally{await x.close();}
});

test('an unresolved task takes ownership and locks a fresh price proposal without losing its record',async()=>{
 const x=await blockerFixture();try{
  x.journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('unknown-owner',x.review.shopId,'unknown-owner','unknown',JSON.stringify({plans:[x.f.plan],submitAttempts:1,riskAttempts:1}),Date.now());
  const pending=await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json(),blockers=await(await fetch(x.app.url+'/api/recovery-blockers')).json();assert.equal(pending.pending,0);assert.equal(x.app.snapshot().priceReviewsPending,0);const record=blockers.records.find(r=>r.productId===x.review.productId);assert.equal(record.category,'verification');assert.equal(record.priceReview.canConfirm,false);
  const detail=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+x.review.productId)).json();assert.equal(detail.blocked,true);assert.equal(detail.review.id,x.review.id);
 }finally{await x.close();}
});

test('new price page approval requires explicit single-product exception and history opens read-only exact rows',async()=>{
 const x=await blockerFixture();try{
  const base={shopId:x.review.shopId,reviewId:x.review.id,key:x.review.key,decision:'approve',acceptPriceAndRisk:true,confirmedSkuIds:x.review.rows.map(r=>r.id)};
  assert.equal((await x.post('price-reviews/decide',base)).status,400);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
  const accepted=await x.post('price-reviews/decide',{...base,acceptBlockedPriceChange:true});assert.equal(accepted.status,200,await accepted.clone().text());
  const history=await(await fetch(x.app.url+'/api/price-reviews?scope=history')).json();assert.equal(history.total,1);assert.equal(history.pending,0);assert.equal(history.reviews[0].status,'approved');
  const detail=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+x.review.productId+'&reviewId='+x.review.id)).json();assert.equal(detail.readOnly,true);assert.equal(detail.review.manualEditable,false);assert.equal(detail.review.options,undefined);assert.equal(detail.recheckReview,null);
 }finally{await x.close();}
});

test('declined and expired suggestions belong to recovery rechecks, with queue state on the same product row',async()=>{
 const x=await blockerFixture();try{
  x.journal.decidePriceReview(x.review.shopId,x.review.id,x.review.key,'decline');
  x.journal.putSettings('priority-recovery:'+x.review.shopId,{schema:1,paused:true,items:[{id:'request',productId:x.review.productId,state:'pending',requestedAt:Date.now(),reason:'重新核验'}]});
  const pending=await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json(),blockers=await(await fetch(x.app.url+'/api/recovery-blockers')).json();assert.equal(pending.total,0);assert.equal(blockers.records.length,1);assert.equal(blockers.records[0].category,'declined');assert.equal(blockers.records[0].recheck.state,'paused');
 }finally{await x.close();}
});

test('scope filtering, ownership exclusion and directional counts happen before pagination',()=>{
 const journal=new Journal(':memory:');try{
  seedPriceQueue(journal,{pending:30,approved:10});const reviews=journal.priceReviews('900001'),hiddenProductIds=[reviews.find(r=>r.status==='pending').productId],tasks=reviews.filter(r=>r.status==='pending').slice(1,4).map((r,i)=>({id:'unknown'+i,shopId:'900001',phase:'unknown',updatedAt:Date.now(),plans:[{productId:r.productId}]}));
  const owner=workspaceOwnership({shopId:'900001',reviews,tasks,hiddenProductIds});assert.equal(owner.priceReviewIds.length,26);const seen=new Set();for(let page=0;page<6;page++){const result=journal.priceReviewPage('900001',{scope:'pending',allowedReviewIds:owner.priceReviewIds,hiddenProductIds,page,pageSize:5,hideExpiredAt:Date.now()});assert.equal(result.total,26);assert.equal(result.directionCounts.increase,26);for(const r of result.reviews){assert.ok(!seen.has(r.id));seen.add(r.id);}}
  assert.equal(seen.size,26);assert.equal(journal.priceReviewPage('900001',{scope:'history',hideExpiredAt:Date.now()}).total,10);assert.equal(journal.priceReviewPage('900001',{scope:'history',direction:'increase',hideExpiredAt:Date.now()}).directionCounts.increase,10);
 }finally{journal.close();}
});

test('care mode owns non-reducing pending work in the background and gives the shared detail a distinct reason',async()=>{
 const x=await blockerFixture();try{
  for(const row of x.review.rows)row.saleFen=Math.max(row.saleFen,row.previousFen);x.journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(x.review),x.review.id);assert.equal((await x.post('care-recovery-policy',{shopId:x.review.shopId,enabled:true,acceptNonReducingRecovery:true})).status,200);
  const prices=await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json(),blockers=await(await fetch(x.app.url+'/api/recovery-blockers')).json(),detail=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+x.review.productId)).json();
  assert.equal(prices.total,0);assert.equal(x.app.snapshot().priceReviewsPending,0);const record=blockers.records.find(r=>r.productId===x.review.productId);assert.equal(record.carePending,true);assert.equal(record.priceReview.canConfirm,false);assert.equal(record.category,'processing');assert.equal(detail.blocked,true);assert.match(detail.blockedReason,/后台正在核验/);assert.doesNotMatch(detail.blockedReason,/未知/);
  const lower={...x.review,rows:x.review.rows.map((row,i)=>i?row:{...row,saleFen:row.previousFen-1})},owner=workspaceOwnership({shopId:x.review.shopId,reviews:[lower],careEnabled:true});assert.equal(owner.byProduct.get(x.review.productId).owner,'prices');
 }finally{await x.close();}
});

test('confirmation history contains decisions only and an expired proposal never replaces a readonly approved target',async()=>{
 const x=await blockerFixture();try{
  const approved={...x.review,id:'approved-history',status:'approved',expiresAt:Date.now()-1000},superseded={...x.review,id:'old-suggestion',status:'superseded'},expired={...x.review,status:'pending',expiresAt:Date.now()-1000};
  for(const review of [approved,superseded])x.journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(review.id,review.shopId,review.productId,review.status,JSON.stringify(review),Date.now());x.journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(expired),expired.id);x.journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(approved.shopId,approved.productId,approved.id);
  const history=await(await fetch(x.app.url+'/api/price-reviews?scope=history')).json();assert.deepEqual(history.reviews.map(r=>r.id),[approved.id]);const detail=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+approved.productId)).json();assert.equal(detail.review.id,approved.id);assert.equal(detail.readOnly,true);assert.equal(detail.review.options,undefined);assert.equal(detail.canRecalculate,true);assert.equal(detail.review.canRecalculate,false);assert.equal(detail.recheckReview.id,expired.id);assert.equal((await(await fetch(x.app.url+'/api/price-reviews/item?productId='+approved.productId+'&reviewId='+approved.id)).json()).canRecalculate,false);
  const recalculated=await x.post('price-reviews/decide',{shopId:expired.shopId,reviewId:detail.recheckReview.id,key:detail.recheckReview.key,decision:'recalculate'});assert.equal(recalculated.status,200);assert.equal(x.journal.priceReview(expired.id).status,'superseded');assert.equal(x.journal.priceTarget(approved.shopId,approved.productId).id,approved.id);assert.equal(x.journal.priceReview(approved.id).status,'approved');
  assert.equal((await fetch(x.app.url+'/api/price-reviews/item?productId='+approved.productId+'&reviewId='+superseded.id)).status,400);
 }finally{await x.close();}
});

test('latest declined advice can explicitly request fresh evidence, while history and unknown tasks stay locked',async()=>{
 const x=await blockerFixture();try{
  x.journal.decidePriceReview(x.review.shopId,x.review.id,x.review.key,'decline');const url=x.app.url+'/api/price-reviews/item?productId='+x.review.productId;
  const detail=await(await fetch(url)).json();assert.equal(detail.readOnly,true);assert.equal(detail.canRecalculate,true);assert.equal(detail.review.canRecalculate,true);assert.equal(detail.review.manualEditable,false);assert.equal((await(await fetch(url+'&reviewId='+x.review.id)).json()).canRecalculate,false);
  const recalculated=await x.post('price-reviews/decide',{shopId:x.review.shopId,reviewId:x.review.id,key:x.review.key,decision:'recalculate'});assert.equal(recalculated.status,200,await recalculated.clone().text());assert.equal(x.journal.priceReview(x.review.id).status,'superseded');
  const freshTask=x.journal.transition(x.f.task.id,'blocked','queued',{},Date.now()),newReview=x.journal.recordPriceReview(makePriceReviews(freshTask,{...x.f.probe,observedAt:Date.now()},Date.now())[0]);x.journal.transition(freshTask.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED'},Date.now());assert.notEqual(newReview.id,x.review.id);assert.equal(newReview.status,'pending');assert.equal((await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json()).total,1);
  x.journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('declined-unknown',x.review.shopId,'declined-unknown','unknown',JSON.stringify({plans:[x.f.plan],submitAttempts:1,riskAttempts:0}),Date.now());const locked=await(await fetch(url)).json();assert.equal(locked.canRecalculate,false);assert.equal(locked.blocked,true);assert.equal((await x.post('price-reviews/decide',{shopId:x.review.shopId,reviewId:newReview.id,key:newReview.key,decision:'recalculate'})).status,400);assert.equal(x.journal.priceReview(newReview.id).status,'pending');
 }finally{await x.close();}
});
