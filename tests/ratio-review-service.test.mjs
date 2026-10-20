import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint} from '../src/policy.mjs';
import {setPriceIncreasePolicy} from '../src/price-increase-policy.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';

for(const batch of [false,true])for(const priority of [false,true])for(const mixed of [false,true])
test(`ratio blocker creates exact pending prices without any draft or automatic consent: ${batch}/${priority}/${mixed}`,async()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j,{mixed}),executed=[];
  j.putSettings('application',{accounts:[{shopId:f.policy.shopId}]});
  setPriceIncreasePolicy(j,f.policy.shopId,{enabled:true,acceptHigherPricesAndRisk:true},now-1);
  const platform={discover:async()=>({activeComplete:true,baselines:[]}),
   loss:async()=>structuredClone(f.loss),precheck:async()=>structuredClone(f.current),
   ...(batch?{lossBatch:async()=>[{productId:f.baseline.productId,loss:structuredClone(f.loss)}],
    precheckBatch:async()=>[structuredClone(f.current)]}:{}),
   prepare:async()=>assert.fail('Unconfirmed ratio prices must not be filled')};
  const service=new GuardianService({journal:j,platform,policy:f.policy,now:()=>now});
  service.execute=async task=>executed.push(...task.plans);
  const run=()=>priority?service.recoverPriority([{productId:f.baseline.productId,watchKey:'ratio-watch'}]):service.tick();
  await run();
  const reviews=j.priceReviews(f.policy.shopId);
  assert.equal(reviews.length,1,'A live ratio blocker must produce a review rather than only a log entry');
  const r=reviews[0];
  assert.equal(r.status,'pending');assert.equal(r.kind,'sku-price-ratio');
  assert.equal(r.source,'live-platform-removal-export');
  assert.equal(r.taskId,null);assert.equal(j.list(f.policy.shopId).length,0);
  assert.equal(j.priceTarget(f.policy.shopId,f.baseline.productId),null);
  assert.equal(executed.length,0);
  assert.equal(r.rows.some(row=>row.saleFen<row.previousFen),mixed);
  assert.deepEqual(r.rows.map(row=>row.discount),mixed?[95,31]:[72,50]);
  assert.equal(fingerprint(j.histories(f.policy.shopId)[0]),fingerprint(f.baseline));
  assert.throws(()=>service.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',acceptPriceAndRisk:true,
   confirmedSkuIds:[r.rows[0].id]}),{code:'PRICE_CONSENT_REQUIRED'});
  service.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',acceptPriceAndRisk:true,
   confirmedSkuIds:r.rows.map(row=>row.id)});
  await run();
  assert.equal(executed.length,1);
  assert.equal(j.list(f.policy.shopId)[0].lossEvidence.priceRules[0].removalEvidence.source,'live-platform-removal-export');
  assert.deepEqual(executed[0].skus.map(s=>s.discount),r.rows.map(row=>row.discount));
  j.assertPricePlans(f.policy.shopId,executed);
 }finally{j.close();}
});
