import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';

for(const count of [3,50])test(count+' products: one draft-only price rejection waits for consent while all other products recover together',{timeout:300000},async()=>{
 const products=Array.from({length:count},(_,i)=>({productId:String(3300000000000000000n+BigInt(i)),name:'草稿隔离商品'+i,
  skus:[{id:String(5300000000000000000n+BigInt(i)),name:'唯一规格',baseFen:10000+i*100,discount:60}]}));
 const bad=products[0],fixture=await fixtureServer({catalogProducts:products,limited:true,detailObservedPrices:true,skuPriceCaps:{[bad.skus[0].id]:5500}});
 const original=fixture.state.campaigns[0],at=Math.floor(Date.now()/1000)*1000;
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:at-60000,endAt:at-60000+7*86400000,
  products:[],removals:products.map(p=>({...p,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}))});
 const dir=await mkdtemp(join(tmpdir(),'guardian-draft-isolate-')),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true},platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 try{
  const baselines=products.map(p=>({...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',campaignId:original.id,
   durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}}));
  for(const b of baselines)journal.remember(b);journal.lease(policy.shopId,service.owner,Date.now(),300000);
  const failures=[];await service.recoverBatch(baselines.map(baseline=>({baseline})),(m,e)=>failures.push({productId:m.baseline.productId,code:e.code,reason:e.message}));
  const tasks=journal.list(policy.shopId),verified=tasks.filter(t=>t.phase==='verified'),reviews=journal.priceReviews(policy.shopId);
  const result={at:new Date().toISOString(),localFixtureOnly:true,blockedProducts:failures,tasks:tasks.map(t=>({id:t.id,phase:t.phase,products:t.plans.map(p=>p.productId),submitAttempts:t.submitAttempts,reason:t.reason})),
   reviews:reviews.map(r=>({productId:r.productId,status:r.status,source:r.source,prices:r.rows.map(s=>({id:s.id,previousFen:s.previousFen,saleFen:s.saleFen}))})),submits:fixture.state.submits,risks:fixture.state.risks,uploads:fixture.state.uploads};
  await writeFile(resolve('artifacts/draft-price-isolation-'+count+'.json'),JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(verified.flatMap(t=>t.plans.map(p=>p.productId)).sort(),products.slice(1).map(p=>p.productId).sort());
  assert.equal(verified.length,1);assert.equal(verified[0].receipt.productCount,count-1);assert.equal(verified[0].receipt.skuCount,count-1);
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);assert.equal(reviews.length,1);assert.equal(reviews[0].productId,bad.productId);assert.equal(reviews[0].status,'pending');
  assert.deepEqual(failures.map(f=>f.productId),[bad.productId]);assert.ok(tasks.filter(t=>t.plans.some(p=>p.productId===bad.productId)).every(t=>t.submitAttempts===0));
  assert.ok(fixture.state.seenPrices.filter(p=>p.id===bad.skus[0].id).every(p=>p.discount===60),'unapproved lower prices must never be entered');
  assert.equal(journal.priceTarget(policy.shopId,bad.productId),null);assert.equal(fixture.state.cancelAttempts||0,0);
  const parent=tasks.find(t=>t.phase==='blocked');assert.equal(parent.plans.length,count);assert.equal(parent.riskAttempts,0);
  const isolated=journal.events(50).find(e=>e.kind==='batch-draft-price-isolated');assert.ok(isolated);
  await service.tick();assert.equal(fixture.state.submits,1,'a later patrol must not duplicate the recovered clean members');
  assert.equal(journal.priceTarget(policy.shopId,bad.productId),null);assert.equal(journal.priceReviews(policy.shopId)[0].status,'pending');
  await writeFile(resolve('artifacts/draft-price-isolation-'+count+'.json'),JSON.stringify({...result,
   cleanBatchSize:count-1,readbackProducts:verified[0].receipt.productCount,readbackSkus:verified[0].receipt.skuCount,
   laterPatrolNoDuplicate:true,source:'local-native-browser-fixture',liveShopTouched:false},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

for(const mixed of [false,true])test('draft price isolation preserves the shop numeric-increase grant and mixed-price human consent: '+mixed,{timeout:180000},async()=>{
 const products=Array.from({length:3},(_,i)=>({productId:String(3400000000000000000n+BigInt(i)),name:'自动提价隔离商品'+i,
  skus:Array.from({length:2},(_,k)=>({id:String(5400000000000000000n+BigInt(i*10+k)),name:'规格'+k,baseFen:10000+k*100,discount:60}))}));
 const bad=products[0],fixture=await fixtureServer({catalogProducts:products,limited:true,detailObservedPrices:true,
  skuPriceFloors:{[bad.skus[0].id]:6100},skuPriceCaps:mixed?{[bad.skus[1].id]:5900}:{}});
 const original=fixture.state.campaigns[0],at=Math.floor(Date.now()/1000)*1000;
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:at-60000,endAt:at-60000+7*86400000,
  products:products.map(p=>({...p,activityLimit:1000,removalConfirmed:true,removalRiskConfirmed:true}))});
 const dir=await mkdtemp(join(tmpdir(),'guardian-draft-isolate-grant-')),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 new AccountRegistry(journal).register({shopId:'900001'},'signin-isolation');setPriceIncreasePolicy(journal,'900001',{enabled:true,acceptHigherPricesAndRisk:true});
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true},platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 try{
  const baselines=products.map(p=>({...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',campaignId:original.id,
   durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}}));
  for(const b of baselines)journal.remember(b);journal.lease(policy.shopId,service.owner,Date.now(),300000);
  const failures=[];await service.recoverBatch(baselines.map(baseline=>({baseline})),(m,e)=>failures.push({productId:m.baseline.productId,code:e.code}));
  assert.equal(fixture.state.submits,1);assert.equal(journal.list(policy.shopId).find(t=>t.phase==='verified').plans.length,2);
  const review=journal.priceReviews(policy.shopId)[0];assert.equal(review.productId,bad.productId);
  await service.recoverPriceIncreases();
  if(mixed){
   assert.equal(review.status,'pending');assert.equal(journal.priceTarget(policy.shopId,bad.productId),null);
   assert.equal(fixture.state.submits,1);assert.ok(fixture.state.seenPrices.every(p=>p.discount===60));
  }else{
   assert.equal(review.approvalKind,'automatic-price-increase');assert.equal(fixture.state.submits,2);assert.equal(fixture.state.risks,2);
   const restored=journal.list(policy.shopId).find(t=>t.phase==='verified'&&t.plans.some(p=>p.productId===bad.productId));
   assert.ok(restored);assert.equal(restored.receipt.skuCount,2);assert.equal(restored.plans[0].skus[0].saleFen,6100);
   assert.ok(fixture.state.seenPrices.every(p=>p.discount>=60));
  }
  assert.equal(fixture.state.cancelAttempts||0,0);assert.ok(journal.histories(policy.shopId).every(b=>b.skus.every(s=>s.discount===60)));
  await writeFile(resolve('artifacts/draft-price-isolation-'+(mixed?'mixed':'automatic')+'.json'),JSON.stringify({at:new Date().toISOString(),
   localFixtureOnly:true,liveShopTouched:false,mixed,submits:fixture.state.submits,risks:fixture.state.risks,
   verifiedProducts:journal.list(policy.shopId).filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0),
   priceReviewStatus:review.status,automaticGrantOnly:!mixed,noUnapprovedDecreases:true,cleanMembersTogether:2},null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
