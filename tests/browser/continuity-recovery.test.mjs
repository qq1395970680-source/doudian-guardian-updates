import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {fingerprint} from '../../src/policy.mjs';

test('44 native fresh old/new activity removals reach exact price confirmation without unapproved uploads',{timeout:300000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-continuity44-'));let j=new Journal(join(dir,'guardian.sqlite'));
 const products=Array.from({length:44},(_,i)=>({productId:String(300001+i),name:'跨期商品'+i,
  skus:Array.from({length:i<26?(i<18?10:9):i<36?(i===26?10:9):(i<38?8:7)},(_,n,array)=>{
   const count=i<26?(i<18?10:9):i<36?(i===26?10:9):(i<38?8:7);
   return{id:String(500001+i*20+n),name:n===0?'低价规格':n===count-1?'高价规格':'中间规格'+n,baseFen:n===0?10000:n===count-1?70000:20000+n*100,discount:50};
  })}));
 const other={productId:'399999',name:'正常在活动商品',activityLimit:1000,skus:[{id:'599999',name:'标准规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({limited:true,catalogProducts:[...products,other],formPageSize:10,dropAfterSubmit:true});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}}),now=Math.floor(Date.now()/1000)*1000;
 const rules={noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true};
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[other.productId]};
 const removals=(rows,fives)=>rows.map((p,i)=>({productId:p.productId,name:p.name,reason:`该商品各SKU售卖价，最高价需在最低价的${i>=rows.length-fives?'5.3':'3.5'}倍以内，请修改后再提交。`}));
 const old=(id,name,rows,removed)=>({id,name,type:'限量抢购',status:'已结束',startAt:now-8*86400000,endAt:now-86400000,autoRenew:true,risk:!!removed,
  products:rows.length?rows.map(p=>({...p,activityLimit:1000})):[other],...(removed?{removals:removed}:{})});
 const campaigns=[old('400001','旧活动A',[],removals(products.slice(0,26),2)),old('400002','旧活动B',products.slice(26,36)),old('400003','旧活动C',products.slice(36))];
 campaigns.push({id:'400004',name:'旧活动B',type:'限量抢购',status:'进行中',startAt:now-86400000+1000,endAt:now+6*86400000+1000,autoRenew:true,risk:true,products:[other],removals:removals(products.slice(26,36),2)},
  {id:'400005',name:'旧活动C',type:'限量抢购',status:'进行中',startAt:now-86400000+1000,endAt:now+6*86400000+1000,autoRenew:true,risk:true,products:[other],removals:removals(products.slice(36),1)});
 fixture.state.campaigns=campaigns;
 products.forEach((p,i)=>j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...p,type:'限量抢购',rules,durationMs:7*86400000,activityLimit:1000,
  campaignId:i<26?'400001':i<36?'400002':'400003',historyAt:now-8*86400000,observedAt:now-2*86400000}));
 const originalRecords=j.histories(policy.shopId).map(fingerprint);
 let platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),service=new GuardianService({journal:j,platform,policy});
 try{
  await service.tick();const reviews=j.priceReviews(policy.shopId),checks=j.productChecks(policy.shopId);
  assert.equal(reviews.length,44,JSON.stringify({status:service.status(),checks,events:j.events(12)}));
  assert.equal(reviews.filter(r=>r.ratio.numerator/r.ratio.denominator===3.5).length,39);
  assert.equal(reviews.filter(r=>r.ratio.numerator/r.ratio.denominator===5.3).length,5);
  assert.ok(reviews.every(r=>r.status==='pending'&&r.rows.length===products.find(p=>p.productId===r.productId).skus.length&&r.source==='live-platform-removal-export'));
  assert.equal(reviews.reduce((n,r)=>n+r.rows.length,0),401);
  for(const r of reviews){const index=products.findIndex(p=>p.productId===r.productId);assert.equal(r.sourceProof.campaignId,index<26?'400001':index<36?'400004':'400005');}
  assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.submits,0);assert.equal(j.list(policy.shopId).length,0);
  assert.ok(checks.every(c=>c.code==='SKU_RATIO_REVIEW_REQUIRED'));
  assert.ok(fixture.state.removalDownloads<44,'Same-source reads are shared within each bounded batch');
  assert.equal(browser.context.pages().filter(p=>/view|create/.test(p.url())).length,0);
  const chosen=[reviews.find(r=>r.sourceProof.campaignId==='400001'&&r.ratio.numerator/r.ratio.denominator===5.3),
   reviews.find(r=>r.sourceProof.campaignId==='400004'&&r.ratio.numerator/r.ratio.denominator===5.3)];
  for(const review of chosen)service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true});
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(service.status().unknown,1);
  service.stop();await browser.close();j.close();j=new Journal(join(dir,'guardian.sqlite'));
  platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base});service=new GuardianService({journal:j,platform,policy});
  await service.tick();assert.equal(service.status().verified,2);assert.equal(service.status().unknown,0);assert.equal(fixture.state.submits,1);
  const verified=j.list(policy.shopId).find(t=>t.phase==='verified');assert.equal(verified.receipt.skuCount,chosen.reduce((n,r)=>n+r.rows.length,0));
  await service.tick();assert.equal(fixture.state.submits,1,'A later patrol must not repeat the restored batch');
  assert.ok(originalRecords.every(hash=>j.histories(policy.shopId).some(b=>fingerprint(b)===hash)));
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/continuity-44-native-prices.json'),JSON.stringify({localFixtureOnly:true,products:44,skus:401,oldExpiredSourceProducts:26,newExactSourceProducts:18,
   ratio35:39,ratio53:5,pendingReviewsBeforeConsent:44,unconfirmedUploads:0,unconfirmedSubmits:0,submitsAfterExactConsent:1,verifiedAfterUnknownRestart:2,unknown:0,laterPatrolNoDuplicate:true,removalDownloads:fixture.state.removalDownloads,
   fullSkuHistoryRetained:true},null,2)+'\n');
 }finally{service.stop();await browser.close();j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('verified natural expiry restores original limited rules and exact duration then patrols without repeating',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-natural-renewal-')),j=new Journal(join(dir,'guardian.sqlite'));
 const product={productId:'300001',name:'正常到期商品',skus:[{id:'500001',name:'标准规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({limited:true,catalogProducts:[product]}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true}),now=Math.floor(Date.now()/1000)*1000;
 const c=fixture.state.campaigns[0],duration=28*86400000+7000;
 Object.assign(c,{type:'限量抢购',status:'已结束',startAt:now-duration-3600000,endAt:now-3600000,autoRenew:true,products:[{...product,activityLimit:1000}]});
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:c.id,type:c.type,durationMs:duration,activityLimit:1000,
  historyAt:c.startAt,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 const p=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),service=new GuardianService({journal:j,platform:p,policy});
 try{
  await service.tick();assert.equal(service.status().verified,1,JSON.stringify({status:service.status(),checks:j.productChecks(policy.shopId),events:j.events(10)}));
  const t=j.list(policy.shopId).find(t=>t.phase==='verified');assert.equal(t.lossEvidence.continuities[0].kind,'expired-renewal');
  assert.equal(t.receipt.endAt-t.receipt.startAt,duration);assert.equal(t.receipt.durationMs,duration);assert.equal(t.receipt.productLimits[0].activityLimit,1000);
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(fixture.state.cancelAttempts,undefined);
  await writeFile(resolve('artifacts/continuity-natural-renewal-native.json'),JSON.stringify({localFixtureOnly:true,verified:1,submits:1,durationMs:duration,exactSkuReadback:true,laterPatrol:true,duplicateSubmits:0},null,2)+'\n');
 }finally{service.stop();await browser.close();j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
