import test from 'node:test';
import assert from 'node:assert/strict';
import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';

test('an explicit history review ID is read-only even when it is the current pending proposal',async()=>{
 const x=await blockerFixture();try{
  const url=x.app.url+'/api/price-reviews/item?productId='+x.review.productId;
  const current=await(await fetch(url)).json();
  assert.equal(current.readOnly,false);assert.equal(current.review.manualEditable,true);assert.ok(current.review.options.length);assert.equal(current.canRecalculate,true);
  // An earlier stored display decoration cannot leak editable options into an
  // explicit record view. The ordinary current item still derives fresh ones.
  const decorated={...x.review,options:[{id:'stored-display-option',available:true}]};
  x.journal.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(decorated),x.review.id);
  const response=await fetch(url+'&reviewId='+x.review.id),history=await response.json();assert.equal(response.status,200);
  assert.equal(history.review.id,x.review.id);assert.equal(history.review.status,'pending');assert.equal(history.readOnly,true);
  assert.equal(history.review.manualEditable,false);assert.equal(history.review.options,undefined);assert.deepEqual(history.review.manualTypes,[]);
  assert.equal(history.canRecalculate,false);assert.equal(history.review.canRecalculate,false);assert.equal(history.recheckReview,null);
  const restored=await(await fetch(url)).json();assert.equal(restored.readOnly,false);assert.ok(restored.review.options.length);assert.equal(restored.review.options.some(option=>option.id==='stored-display-option'),false);
  assert.equal(x.journal.priceReview(x.review.id).status,'pending');assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);
 }finally{await x.close();}
});
