import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {formSlice} from '../../src/platform-snapshot.mjs';

test('50 limited products / 500 SKUs use one upload and bounded quantity traversal despite row reflow',{timeout:240000},async()=>{
 const products=Array.from({length:50},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'批量限量商品'+i,
  skus:Array.from({length:10},(_,j)=>({id:String(5000000000000000000n+BigInt(i*10+j)),name:'规格'+j,baseFen:10000+i*10+j,discount:60}))}));
 const fixture=await fixtureServer({catalogProducts:products,limited:true,quotaReflowPx:600});
 const dir=await mkdtemp(join(tmpdir(),'guardian-large-limited-')),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 let quantitySnapshots=0;
 const fill=platform.fillProductLimits.bind(platform);
 platform.fillProductLimits=async(page,plans)=>{
  const evaluate=page.evaluate.bind(page);
  page.evaluate=async(fn,...args)=>{
   if(fn===formSlice){quantitySnapshots++;assert.ok(quantitySnapshots<=300,'quantity fill must not traverse the entire SKU table per product');}
   return evaluate(fn,...args);
  };
  try{return await fill(page,plans);}finally{page.evaluate=evaluate;}
 };
 try{
  const plans=products.map((p,i)=>{
   const b={...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',
    campaignId:'4000000000000000001',rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},durationMs:7*86400000,activityLimit:1000-i};
   journal.remember(b);return planOriginalRestore(b,{...b,observedAt:Date.now()},policy);
  });
  const started=Date.now(),task=journal.enqueue(policy.shopId,plans,{complete:true,observedAt:started,lossKey:'local-large-batch'});
  journal.lease(policy.shopId,service.owner,Date.now(),300000);await service.execute(task);
  const actual=journal.get(task.id);assert.equal(actual.phase,'verified',actual.reason);
  assert.equal(actual.receipt.skuCount,500);assert.equal(actual.receipt.productCount,50);
  assert.equal(fixture.state.uploads,1);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);
  assert.deepEqual(actual.receipt.productLimits.map(p=>p.activityLimit),plans.map(p=>p.activityLimit));
  await writeFile(resolve('artifacts/large-limited-batch.json'),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,
   products:50,skus:500,uploads:1,submits:1,independentReadback:true,quantitySnapshots,quotaReflowPx:600,elapsedMs:Date.now()-started},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.ok(basename(dir).startsWith('guardian-large-limited-'));
  await rm(dir,{recursive:true,force:true});
 }
});

for(const count of [1,3,5,50])test(`${count} removed products in 500 activities use scoped browser reads and fresh live origin exports`,{timeout:180000},async()=>{
 const products=Array.from({length:count},(_,i)=>({productId:String(3100000000000000000n+BigInt(i)),name:'大店失效商品'+i,
  skus:[{id:String(5100000000000000000n+BigInt(i)),name:'标准规格',baseFen:10000,discount:60}]}));
 const fixture=await fixtureServer({catalogProducts:products,limited:true});
 const original=fixture.state.campaigns[0],started=Date.now();
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:Math.floor(started/1000)*1000,
  endAt:Math.floor(started/1000)*1000+7*86400000,products:[],removals:products.map(p=>({...p,reason:'商品低价风险退出'}))});
 for(let i=1;i<500;i++)fixture.state.campaigns.push({...original,id:String(4100000000000000000n+BigInt(i)),
  name:'无关活动'+i,risk:false,removals:undefined,products:[]});
 const dir=await mkdtemp(join(tmpdir(),'guardian-large-loss-')),browser=new DedicatedBrowser(dir,{test:true});
 const journal=new Journal(join(dir,'observations.sqlite'));
 const policy={shopId:'900001'},platform=new DoudianPlatform({browser,policy,journal,base:fixture.base,
  resourceBudget:()=>({detailReaders:2,listReaders:1,overlapListReads:false,keepMonitorPages:false,interBatchDelayMs:0,idleMs:30000})});
 const originReads=[],readDetail=platform.detail.bind(platform);
 platform.detail=async campaign=>{
  const readStartedAt=Date.now(),result=await readDetail(campaign);
  originReads.push({readStartedAt,observedAt:result.observedAt});return result;
 };
 try{
  const listing=await platform.listActive();assert.equal(listing.campaigns.length,500);
  platform.inventory={listing,details:new Map()};
  const baselines=products.map(p=>({...p,shopId:policy.shopId,campaignId:original.id,type:'限量抢购'}));
  const results=await platform.lossBatch(baselines);
  assert.equal(results.length,count);assert.ok(results.every(r=>r.loss?.complete&&r.loss.active===false),
   JSON.stringify(results.filter(r=>r.error).map(r=>({productId:r.productId,code:r.error.code,message:r.error.message}))));
  assert.deepEqual(results.map(r=>r.productId),baselines.map(b=>b.productId));
  assert.ok(results.every(r=>Date.now()-r.loss.observedAt<=120000),'a long low-load batch still requires fresh proofs');
  assert.equal(fixture.state.removalDownloads,originReads.length);
  assert.ok(originReads.length>=1);
  for(let i=1;i<originReads.length;i++)assert.ok(originReads[i].readStartedAt-originReads[i-1].observedAt>60000,
   'repeat origin exports are permitted only after the previously observed proof needs refresh');
  if(count<50)assert.equal(fixture.state.removalDownloads,1);
  const metric=journal.events(10).find(e=>e.kind==='scoped-loss-batch-read')?.detail;
  assert.ok(metric);assert.equal(metric.productCount,count);assert.equal(metric.detailReads,originReads.length);
  assert.equal(metric.errors,0);assert.equal(metric.workerLimit,Math.min(2,count));
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);
  await writeFile(resolve(`artifacts/large-store-loss-evidence-${count}.json`),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,
   storeActivities:500,batchProducts:count,successfulLossProofs:count,liveOriginDownloads:fixture.state.removalDownloads,
   originReads,allProofsFresh:true,writes:0,metric,elapsedMs:Date.now()-started},null,2)+'\n');
 }finally{
  await browser.close();await fixture.close();journal.close();
  assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.ok(basename(dir).startsWith('guardian-large-loss-'));
  await rm(dir,{recursive:true,force:true});
 }
});
