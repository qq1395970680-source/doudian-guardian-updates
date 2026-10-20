import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const [mixed,capped] of [[false,false],[true,false],[false,true]])test('native headless ratio proposal requires consent, then exact limited readback and unknown restart: '+mixed+'/'+capped,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-ratio-flow-'));
 const product={productId:'300001',name:'倍率测试商品',skus:[
  {id:'500001',name:'小规格',baseFen:mixed?4700:10000,discount:50},
  {id:'500002',name:'大规格',baseFen:mixed?50300:50000,discount:50}]};
 const other={productId:'300002',name:'正常商品',skus:[{id:'500003',name:'其他规格',baseFen:10000,discount:60}]};
 const fixture=await fixtureServer({catalogProducts:[product,other],limited:true,dropAfterSubmit:mixed,skuPriceCaps:capped?{'500001':7000}:{},productPriceSummary:capped?'部分规格打折填写错误。\n立即收起':''});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}});
 let j=new Journal(join(dir,'journal.sqlite'));
 const policy={shopId:'900001',excludedProductIds:[other.productId],allowMissingHistoricalSkus:true,
  originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const campaign=fixture.state.campaigns[0],startAt=Math.floor(Date.now()/1000)*1000;
 Object.assign(campaign,{type:'限量抢购',status:'进行中',startAt,endAt:startAt+7*86400000,autoRenew:true,risk:true,
  products:[{...other,activityLimit:1000}],
  removals:[{productId:product.productId,name:product.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]});
 const baseline={source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:campaign.id,
  type:'限量抢购',activityLimit:1000,durationMs:7*86400000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}};
 j.remember(baseline);j.putSettings('application',{accounts:[{shopId:policy.shopId}]});
 setPriceIncreasePolicy(j,policy.shopId,{enabled:true,acceptHigherPricesAndRisk:true});
 let platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base});
 let service=new GuardianService({journal:j,platform,policy});
 try{
  await service.tick();
  let review=j.priceReviews(policy.shopId)[0];
  assert.ok(review,JSON.stringify({status:service.status(),events:j.events(10)}));
  assert.equal(review.source,'live-platform-removal-export');assert.equal(review.kind,'sku-price-ratio');
  assert.deepEqual(review.rows.map(r=>r.discount),mixed?[95,31]:[72,50]);
  assert.equal(review.status,'pending');assert.equal(fixture.state.uploads,0);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);
  assert.ok(fixture.state.removalDownloads>0);assert.equal(j.list(policy.shopId).length,0);
  service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',
   confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true});
  await service.tick();
  if(capped){
   assert.equal(fixture.state.submits,0,'the numeric cap must not submit a ratio-breaking target');
   const next=j.priceReviews(policy.shopId).find(r=>r.status==='pending');
   assert.ok(next,JSON.stringify(j.events(10)));
   assert.equal(next.source,'live-platform-draft');assert.equal(next.kind,'sku-price-ratio');
   assert.equal(next.previousApprovalId,review.id);assert.deepEqual(next.rows.map(r=>r.discount),[70,49]);
   assert.ok(fixture.state.seenPrices.every(row=>row.discount>=(row.id==='500001'?72:50)));
   service.decidePriceReview({reviewId:next.id,key:next.key,decision:'approve',
    confirmedSkuIds:next.rows.map(r=>r.id),acceptPriceAndRisk:true});
   review=next;await service.tick();
  }
  assert.equal(fixture.state.submits,1,JSON.stringify({status:service.status(),events:j.events(10)}));
  assert.equal(fixture.state.risks,1);
  if(mixed){
   assert.equal(service.status().unknown,1);
   service.stop();await browser.close();j.close();j=new Journal(join(dir,'journal.sqlite'));
   platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base});
   service=new GuardianService({journal:j,platform,policy});
   await service.tick();assert.equal(fixture.state.submits,1,'unknown result must only be read after restart');
  }
  assert.equal(service.status().verified,1);
  const task=j.list(policy.shopId).find(t=>t.phase==='verified');
  assert.equal(task.receipt.type,'限量抢购');assert.equal(task.receipt.skuCount,2);
  assert.deepEqual(task.plans[0].skus.map(s=>s.discount),review.rows.map(r=>r.discount));
  assert.deepEqual(j.histories(policy.shopId).find(h=>h.productId===product.productId&&!h.generatedByGuardian).skus.map(s=>s.discount),[50,50]);
  await service.tick();assert.equal(fixture.state.submits,1);
  assert.equal(fixture.state.cancelAttempts,undefined);
  await mkdir(resolve('artifacts'),{recursive:true});
  await writeFile(resolve('artifacts',`ratio-review-flow-${mixed?'mixed-unknown':capped?'joint-cap':'increase'}.json`),JSON.stringify({
   localFixtureOnly:true,headless:true,directRemovalDownload:true,unconfirmedUploads:0,
   exactHumanConsentTested:true,automaticRatioConsent:false,submits:fixture.state.submits,
   verified:service.status().verified,unknown:service.status().unknown,restartUnknown:mixed,jointNumericCap:capped,
   prices:review.rows.map(r=>({skuId:r.id,previousFen:r.previousFen,saleFen:r.saleFen,discount:r.discount}))
  },null,2)+'\n');
 }finally{service.stop();await browser.close();j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
