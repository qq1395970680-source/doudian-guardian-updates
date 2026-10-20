import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {seedPriceQueue} from './helpers/large-price-queue-fixture.mjs';

test('direction queues classify the whole product, count before pagination and exclude processed history',()=>{
 const j=new Journal(':memory:');
 try{
  seedPriceQueue(j,{pending:35,approved:25});
  seedPriceQueue(j,{shopId:'900002',pending:4,approved:0});
  for(let i=0;i<13;i++){
   const id='900001-review-'+i,r=j.priceReview(id);
   r.rows.push({...r.rows[0],id:'lower-'+i,previousFen:9000,saleFen:8000});
   j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(r),id);
  }
  const up=j.priceReviewPage('900001',{direction:'increase'}),down=j.priceReviewPage('900001',{direction:'decrease'});
  assert.equal(up.total,22);assert.equal(down.total,13);
  assert.deepEqual(up.directionCounts,{increase:22,decrease:13});
  assert.equal(up.direction,'increase');assert.equal(down.direction,'decrease');
  assert.ok(up.reviews.every(r=>r.status==='pending'&&r.rows.every(s=>s.saleFen>=s.previousFen)));
  assert.ok(down.reviews.every(r=>r.rows.some(s=>s.saleFen<s.previousFen)&&r.rows.length===2));
  const next=j.priceReviewPage('900001',{direction:'decrease',page:1});
  assert.equal(next.reviews.length,3);
  assert.equal(new Set([...down.reviews,...next.reviews].map(r=>r.id)).size,13);
  assert.equal(j.priceReviewPage('900001',{direction:'all'}).total,60);
  assert.equal(j.priceReviewPage('900002',{direction:'decrease'}).total,0);
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM price_targets').get().n,0);
 }finally{j.db.close();}
});
