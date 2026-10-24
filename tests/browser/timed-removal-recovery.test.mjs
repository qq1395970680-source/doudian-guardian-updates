import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {priceOptions} from '../../src/price-options.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('timed risk exits produce exact reviews, isolate healthy recovery, then verify confirmed prices and later patrol',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-timed-ratio-')),journal=new Journal(join(dir,'guardian.sqlite'));
 const products=[
  {productId:'300001',name:'限时倍率受限商品',skus:[{id:'500001',name:'低价规格',baseFen:10000,discount:50},{id:'500002',name:'高价规格',baseFen:50000,discount:50}]},
  {productId:'300002',name:'仅涨价无解商品',skus:[{id:'500003',name:'低价规格',baseFen:4700,discount:50},{id:'500004',name:'高价规格',baseFen:50300,discount:50}]},
  {productId:'300003',name:'正常到期商品',skus:[{id:'500005',name:'标准规格',baseFen:10000,discount:50}]}
 ];
 const fixture=await fixtureServer({catalogProducts:products,detailObservedPrices:true});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}}),now=Math.floor(Date.now()/1000)*1000;
 const rules={noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30};
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 const origin=fixture.state.campaigns[0];
 Object.assign(origin,{name:'限时原活动',type:'限时抢购',status:'已失效',risk:true,startAt:now-60000,endAt:now+172740000,
  products:products.slice(0,2),removals:products.slice(0,2).map(p=>({productId:p.productId,name:p.name,
   reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。\n该商品各SKU售卖价，最高价需在最低价的5.3倍以内，请修改后再提交。'}))});
 const ended={id:'410001',name:'正常到期活动',type:'限时抢购',status:'已结束',risk:false,startAt:now-3*86400000,endAt:now-86400000,products:[products[2]]};
 fixture.state.campaigns.push(ended);
 products.forEach((p,i)=>journal.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...p,
  campaignId:i<2?origin.id:ended.id,type:'限时抢购',durationMs:172800000,rules,historyAt:now-3*86400000,observedAt:now-60000}));
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();
  const reviews=journal.priceReviews(policy.shopId).filter(r=>r.status==='pending');
  assert.equal(reviews.length,2,JSON.stringify({checks:journal.productChecks(policy.shopId),events:journal.events(10)}));
  assert.ok(reviews.every(r=>r.type==='限时抢购'&&r.sourceProof.campaignId===origin.id&&r.ratio.numerator/r.ratio.denominator===3.5));
  assert.equal(fixture.state.submits,1,'Healthy product proceeds while exact timed ratio reviews wait');
  assert.ok(fixture.state.seenPrices.every(s=>s.productId===products[2].productId),'No unconfirmed affected SKU is uploaded');
  assert.equal(journal.list(policy.shopId).filter(t=>t.phase==='verified').length,1);
  const impossible=priceOptions(reviews.find(r=>r.productId===products[1].productId)).find(o=>o.id==='raise-low');
  assert.equal(impossible.available,false);assert.ok(impossible.reason);
  const review=reviews.find(r=>r.productId===products[0].productId),option=priceOptions(review).find(o=>o.id==='raise-low');
  assert.equal(option.available,true);assert.ok(option.rows.every(r=>r.saleFen>=r.previousFen));
  service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',optionId:option.id,optionKey:option.key,
   confirmedSkuIds:option.rows.map(r=>r.id),acceptPriceAndRisk:true});
  await service.tick();
  assert.equal(fixture.state.submits,2);assert.equal(service.status().unknown,0);
  const task=journal.list(policy.shopId).find(t=>t.phase==='verified'&&t.plans.some(p=>p.productId===products[0].productId));
  assert.ok(task,JSON.stringify(journal.events(10)));assert.equal(task.receipt.skuCount,2);
  assert.deepEqual(task.plans[0].skus.map(s=>s.saleFen),option.rows.map(r=>r.saleFen));
  const listing=await platform.list({title:task.title}),campaign=listing.campaigns.find(c=>c.id===task.receipt.campaignId),detail=await platform.detail(campaign);
  assert.equal(campaign.status,'进行中');assert.deepEqual(detail.products[0].skus.map(s=>s.saleFen),option.rows.map(r=>r.saleFen));
  await service.tick();assert.equal(fixture.state.submits,2,'Later patrol preserves current restoration instead of inheriting old export');
  assert.equal(journal.priceReviews(policy.shopId).filter(r=>r.status==='pending').length,1);
  assert.equal(fixture.state.cancelAttempts,undefined);
  await writeFile(resolve('artifacts/timed-removal-recovery-native.json'),JSON.stringify({localFixtureOnly:true,
   affectedProducts:2,skuReviews:4,ratio:3.5,unconfirmedAffectedUploads:0,unconfirmedAffectedSubmits:0,healthyVerified:1,
   noIncreaseSolutionExplained:true,confirmedRestorations:1,confirmedSkus:2,independentDisplayedSkuReadback:true,laterPatrolNoDuplicate:true,
   validActivitiesCancelled:0,unknown:0},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
