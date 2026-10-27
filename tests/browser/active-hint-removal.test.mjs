import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {buildCatalog} from '../../src/catalog.mjs';
import {buildRecoveryIssues} from '../../src/recovery-issues.mjs';
import {projectBuild} from '../../src/build.mjs';
import {priceOptions} from '../../src/price-options.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('22 disabled picker rows resolve to 20 independent active members and two exact removal-price blockers through the real recovery queue',{timeout:360000},async()=>{
 const products=Array.from({length:23},(_,i)=>({productId:String(3700000000000000100n+BigInt(i)),name:'续期状态核验商品'+i,activityLimit:1000,
  skus:[{id:String(5700000000000000100n+BigInt(i*2)),name:'高价规格',baseFen:10000,discount:50},
   {id:String(5700000000000000101n+BigInt(i*2)),name:'低价规格',baseFen:1000,discount:50}]}));
 const fixture=await fixtureServer({catalogProducts:products,activePickerProducts:products.slice(0,22).map(p=>p.productId),limited:true,detailObservedPrices:true});
 const at=Math.floor(Date.now()/1000)*1000;
 fixture.state.campaigns.splice(0,1,...[products.slice(0,10),products.slice(10,20),products.slice(22)].map((items,i)=>({
  id:String(4700000000000000100n+BigInt(i)),name:'本期活动'+i,type:'限量抢购',status:'进行中',risk:i===2,autoRenew:true,
  startAt:at-60000,endAt:at+7*86400000-60000,products:structuredClone(items),
  ...(i===2?{removals:products.slice(20,22).map(p=>({productId:p.productId,name:p.name,
   reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}))}:{})})));
 const original=structuredClone(fixture.state.campaigns),directory=await mkdtemp(join(tmpdir(),'guardian-active-removal-'));
 const journal=new Journal(join(directory,'guardian.sqlite')),browser=new DedicatedBrowser(join(directory,'browser'),{test:true});
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[products[22].productId]};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy,immediate:true});
 service.canRunImmediate=()=>false;
 try{
  const discovery=await platform.discover({historyReadLimit:0});assert.equal(discovery.activeComplete,true);
  for(const b of discovery.baselines)journal.remember(b);
  for(const p of products.slice(20,22))journal.remember({...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,
   campaignId:'4700000000000000001',type:'限量抢购',durationMs:7*86400000,historyAt:at-7*86400000,
   rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
  service.requestRecovery(products.slice(0,22).map(p=>p.productId));
  const result=await service.runImmediate({atBoundary:true});assert.equal(result.processed,22);assert.equal(result.submitted,false);
  const checks=journal.productChecks(policy.shopId);assert.equal(checks.length,2);
  assert.ok(checks.every(c=>c.code==='SKU_RATIO_REVIEW_REQUIRED'&&c.activeHintRemoval?.pricePlanReady===false&&c.message.includes('3.5')));
  const catalog=buildCatalog({shopId:policy.shopId,inventory:platform.inventory,histories:journal.histories(policy.shopId),checks});
  const issues=buildRecoveryIssues(catalog,journal.priceReviews(policy.shopId));
  assert.equal(issues.length,2);assert.ok(issues.every(r=>r.pricing&&r.message.includes('3.5')));
  const events=journal.events(300),proofs=events.filter(e=>e.kind==='active-membership-proof-batch');
  assert.equal(new Set(proofs.flatMap(e=>e.detail.productIds)).size,20);
  const removals=events.filter(e=>e.kind==='active-hint-removal-confirmed');assert.equal(removals.length,2);
  assert.ok(removals.every(e=>e.detail.source==='live-platform-removal-export'&&/^[a-f0-9]{64}$/.test(e.detail.sha256)));
  assert.equal(journal.list(policy.shopId).length,0);assert.equal(journal.priceReviews(policy.shopId).length,0);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.risks,0);assert.equal(fixture.state.prechecks,1);
  assert.ok(fixture.state.removalDownloads>0);assert.deepEqual(fixture.state.campaigns,original);
  await writeFile(resolve('artifacts/beta51-picker-removal-browser.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,requestedProducts:22,independentlyConfirmedActive:20,
   exactPriceRestrictionBlockers:2,visibleInPriceConfirmation:true,fullCurrentSkuPlanReady:false,priceProposals:0,priceApprovals:0,
   submissions:0,pickerVisits:fixture.state.prechecks,removalWorkbookDownloads:fixture.state.removalDownloads,validActivitiesPreserved:true},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-active-removal-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

test('a mixed native cohort generates the complete exact price choices before reading unrelated active hints',{timeout:240000},async()=>{
 const products=Array.from({length:3},(_,i)=>({productId:String(3750000000000000100n+BigInt(i)),name:'混合续期商品'+i,activityLimit:1000,
  skus:[{id:String(5750000000000000100n+BigInt(i*2)),name:'高价规格',baseFen:10000,discount:50},
   {id:String(5750000000000000101n+BigInt(i*2)),name:'低价规格',baseFen:2000,discount:50}]}));
 const fixture=await fixtureServer({catalogProducts:products,activePickerProducts:[products[0].productId],limited:true,detailObservedPrices:true});
 const at=Math.floor(Date.now()/1000)*1000;
 fixture.state.campaigns.splice(0,1,{id:'4750000000000000100',name:'同批续期活动',type:'限量抢购',status:'进行中',risk:true,autoRenew:true,
  startAt:at-60000,endAt:at+7*86400000-60000,products:structuredClone([products[0],products[2]]),
  removals:[{productId:products[1].productId,name:products[1].name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]});
 const original=structuredClone(fixture.state.campaigns),directory=await mkdtemp(join(tmpdir(),'guardian-mixed-ready-'));
 const journal=new Journal(join(directory,'guardian.sqlite')),browser=new DedicatedBrowser(join(directory,'browser'),{test:true});
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[products[2].productId]};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy,immediate:true});
 service.canRunImmediate=()=>false;let readyBeforeUnrelatedRead=false;
 try{
  const discovery=await platform.discover({historyReadLimit:0});assert.equal(discovery.activeComplete,true);
  for(const b of discovery.baselines)journal.remember(b);
  journal.remember({...products[1],shopId:policy.shopId,source:'verified-platform-history',complete:true,campaignId:'4750000000000000001',
   type:'限量抢购',durationMs:7*86400000,historyAt:at-7*86400000,
   rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
  const independent=platform.confirmActiveHintBatches.bind(platform);
  platform.confirmActiveHintBatches=async function*(baselines){
   const review=journal.priceReviews(policy.shopId).find(r=>r.productId===products[1].productId);
   assert.equal(review?.status,'pending','The complete current-SKU price proposal must be prepared before unrelated membership reads.');
   readyBeforeUnrelatedRead=true;yield* independent(baselines);
  };
  service.requestRecovery(products.slice(0,2).map(p=>p.productId));
  const result=await service.runImmediate({atBoundary:true});assert.equal(result.submitted,false);assert.equal(readyBeforeUnrelatedRead,true);
  const reviews=journal.priceReviews(policy.shopId);assert.equal(reviews.length,1);
  const review=reviews[0],options=priceOptions(review);
  assert.equal(review.kind,'sku-price-ratio');assert.equal(review.status,'pending');assert.equal(review.rows.length,2);
  assert.deepEqual(options.map(o=>o.id),['original','raise-low','balanced','switch-original']);
  assert.ok(options.filter(o=>['raise-low','balanced'].includes(o.id)).every(o=>o.available&&o.rows.every(r=>r.saleFen>=r.previousFen)));
  assert.equal(journal.list(policy.shopId).length,0);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.risks,0);
  assert.deepEqual(fixture.state.campaigns,original);
  assert.equal(journal.productChecks(policy.shopId).find(c=>c.productId===products[1].productId)?.code,'SKU_RATIO_REVIEW_REQUIRED');
  await writeFile(resolve('artifacts/beta51-mixed-ready-price-browser.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,requestedProducts:2,
   readyPriceProposalBeforeUnrelatedMemberReads:readyBeforeUnrelatedRead,completeCurrentSkuCount:review.rows.length,
   priceChoiceCount:options.length,noReductionChoicesVerified:true,proposalStatus:review.status,priceApprovals:0,submissions:0,
   validActivitiesPreserved:true,source:'live-platform-removal-export-and-current-form'},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-mixed-ready-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
