import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {createApp} from '../src/server.mjs';
import {seedPriceQueue} from './helpers/large-price-queue-fixture.mjs';
import {requestRecovery} from '../src/recovery-requests.mjs';

test('expired suggestions disappear before counts and pagination while approved history and recovery requests remain',async()=>{
 const j=new Journal(':memory:'),shopId='900001',now=Date.now(),runtime=await mkdtemp(join(tmpdir(),'guardian-expired-view-'));
 seedPriceQueue(j,{pending:4,approved:1});
 for(let i=0;i<5;i++){
  const r=j.priceReview(shopId+'-review-'+i);r.expiresAt=i===2?now+3600000:i===1?now:now-1;
  if(i===3)r.status='declined';
  j.db.prepare('UPDATE price_reviews SET state=?,body=? WHERE id=?').run(r.status,JSON.stringify(r),r.id);
 }
 const expired=j.priceReview(shopId+'-review-0');requestRecovery(j,shopId,[{productId:expired.productId,approvalId:expired.id}],'fixture',now-100);
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId},runtime,port:0,dependencies:{journal:j,service,browser:{close:async()=>{}},platform:{}}});
 const get=async path=>(await fetch(app.url+path)).json();
 try{
  const status=await get('/api/status');assert.equal(status.priceReviewsPending,1);assert.equal(status.priceRechecksPending,1);
  const first=await get('/api/price-reviews?size=1');assert.equal(first.total,2);assert.equal(first.pending,1);assert.equal(first.pages,2);
  assert.equal(first.reviews[0].id,shopId+'-review-2');assert.equal(first.rechecks.pending,1);
  const last=await get('/api/price-reviews?size=1&page=99');assert.equal(last.page,1);assert.equal(last.reviews[0].status,'approved');
  assert.equal((await get('/api/price-reviews?direction=increase')).total,1);assert.equal((await get('/api/price-reviews?direction=decrease')).total,0);
  assert.equal(j.priceReviews(shopId).length,5);assert.equal(j.priceReviewCounts(shopId).pending,3);
  assert.equal(j.priceReview(expired.id).status,'pending');assert.equal(j.list(shopId).length,0);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
