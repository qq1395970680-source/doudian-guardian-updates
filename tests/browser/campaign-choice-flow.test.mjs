import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {priceOptions} from '../../src/price-options.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const scenario of ['normal','cap','unknown'])test('selected timed alternative verifies its own platform limits; '+scenario,{timeout:240000},async()=>{
 const capped=scenario==='cap',unknown=scenario==='unknown';
 const dir=await mkdtemp(join(tmpdir(),'guardian-campaign-choice-'));
 const product={productId:'300001',name:'待选择活动商品',skus:[
  {id:'500001',name:'低价规格',baseFen:4700,discount:50},
  {id:'500002',name:'高价规格',baseFen:50300,discount:50}]};
 const other={productId:'300002',name:'保持有效商品',activityLimit:1000,skus:[{id:'500003',name:'正常规格',baseFen:10000,discount:60}]};
 const fixture=await fixtureServer({catalogProducts:[product,other],dropAfterSubmit:unknown,skuPriceCaps:capped?{'500002':20000}:{},productPriceSummary:capped?'部分规格打折填写错误。\n立即收起':''});
 let browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}}),j=new Journal(join(dir,'journal.sqlite'));
 const policy={shopId:'900001',excludedProductIds:[other.productId],allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const campaign=fixture.state.campaigns[0],startAt=Math.floor(Date.now()/1000)*1000;
 Object.assign(campaign,{type:'限量抢购',status:'进行中',startAt,endAt:startAt+7*86400000,autoRenew:true,risk:true,products:[other],
  removals:[{productId:product.productId,name:product.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]});
 j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:campaign.id,
  type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 let platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),service=new GuardianService({journal:j,platform,policy});
 try{
  await service.tick();
  const review=j.priceReviews(policy.shopId)[0],option=priceOptions(review).find(o=>o.id==='switch-original');
  assert.equal(option.validationStatus,'unverified');assert.equal(fixture.state.submits,0);
  service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',optionId:option.id,optionKey:option.key,
   confirmedSkuIds:option.rows.map(r=>r.id),acceptPriceAndRisk:true});
  await service.tick();
  if(unknown){
   assert.equal(service.status().unknown,1);assert.equal(fixture.state.submits,1);
   const target=j.priceTarget(policy.shopId,product.productId);
   service.stop();await browser.close();j.close();
   browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:1440,height:900}});
   j=new Journal(join(dir,'journal.sqlite'));platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base});
   service=new GuardianService({journal:j,platform,policy});
   assert.deepEqual(j.priceTarget(policy.shopId,product.productId),target,'exact activity and price consent survives restart');
   await service.tick();assert.equal(service.status().unknown,0);assert.equal(fixture.state.submits,1,'restart only reads back');
  }
  if(capped){
   assert.equal(fixture.state.submits,0,'switching type must not bypass a numeric price cap');
   const pending=j.priceReviews(policy.shopId).find(r=>r.status==='pending');
   assert.ok(pending,JSON.stringify(j.events(8)));assert.equal(pending.type,'限时抢购');
   assert.equal(pending.campaignTarget.type,'限时抢购');assert.equal(pending.rows[0].discount,50);
   assert.ok(pending.rows[1].saleFen<=20000);assert.equal(pending.ratio,undefined);
  }else{
   assert.equal(service.status().verified,1,JSON.stringify(j.events(10)));
   const task=j.list(policy.shopId).find(t=>t.phase==='verified');
   assert.equal(task.plans[0].type,'限时抢购');assert.deepEqual(task.plans[0].skus.map(s=>s.discount),[50,50]);
   assert.equal(platform.limitedReference(service.latestHistories().get(product.productId)).limited,false);
   await service.tick();assert.equal(fixture.state.submits,1,'next patrol does not recreate an active alternative');
  }
  assert.equal(fixture.state.cancelAttempts,undefined,'valid activities were never cancelled');
  assert.equal(j.priceTarget(policy.shopId,product.productId).selectedOption.id,'switch-original');
 }finally{service.stop();await browser.close();j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
