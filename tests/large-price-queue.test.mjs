import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {createApp} from '../src/server.mjs';
import {seedPriceQueue} from './helpers/large-price-queue-fixture.mjs';

test('500 pending reviews remain counted and reachable when newer history exceeds 200',()=>{
 const j=new Journal(':memory:');try{
  seedPriceQueue(j);seedPriceQueue(j,{shopId:'900002',pending:3,approved:0});
  assert.deepEqual(j.priceReviewCounts('900001'),{total:720,pending:500});
  assert.equal(j.priceReviews('900001').length,720);
  const ids=new Set();
  for(let page=0;page<72;page++){
   const result=j.priceReviewPage('900001',{page});
   assert.equal(result.total,720);assert.equal(result.pending,500);assert.equal(result.pages,72);
   assert.equal(result.reviews.length,10);
   for(const review of result.reviews){assert.equal(review.shopId,'900001');assert.ok(!ids.has(review.id));ids.add(review.id);}
   assert.ok(result.reviews.every(r=>r.status===(page<50?'pending':'approved')));
  }
  assert.equal(ids.size,720);assert.equal(j.priceReviewPage('900001',{page:49}).reviews.at(-1).id,'900001-review-0');
  assert.equal(j.priceReviewPage('900002').total,3);
  assert.deepEqual(j.priceReviewCounts(null),{total:0,pending:0});
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM price_targets').get().n,0);
 }finally{j.db.close();}
});

test('price review pages bound invalid and excessive sizes without hiding deep pages',()=>{
 const j=new Journal(':memory:');try{
  seedPriceQueue(j,{approved:0});
  for(const args of [{page:Infinity,pageSize:Infinity},{page:NaN,pageSize:'bad'},{page:999999,pageSize:999999},{page:-5,pageSize:-6}]){
   const r=j.priceReviewPage('900001',args);assert.ok(r.reviews.length<=20&&r.reviews.length>0);assert.ok(r.page>=0&&r.page<r.pages);assert.equal(r.total,500);
  }
  assert.equal(j.priceReviewPage('900001',{page:49}).reviews.at(-1).id,'900001-review-0');
 }finally{j.db.close();}
});

test('HTTP queue and status expose all counts while sending only the requested page',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-large-price-')),j=new Journal(':memory:');seedPriceQueue(j);
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal:j,service,browser:{close:async()=>{}},platform:{progress:{stage:'test'}}}});
 try{
  assert.equal((await(await fetch(app.url+'/api/status')).json()).priceReviewsPending,500);
  const r=await(await fetch(app.url+'/api/price-reviews?page=49&size=10')).json();
  assert.equal(r.total,720);assert.equal(r.pending,500);assert.equal(r.page,49);assert.equal(r.reviews.length,10);
  assert.equal(r.reviews.at(-1).id,'900001-review-0');
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM price_targets').get().n,0);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
