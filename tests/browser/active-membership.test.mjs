import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {projectBuild} from '../../src/build.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('20 active picker rows are independently verified from two current campaigns without price approval or submission',{timeout:360000},async()=>{
 const products=Array.from({length:21},(_,i)=>({productId:String(3600000000000000100n+BigInt(i)),name:'独立活动成员商品'+i,
  activityLimit:1000,skus:[{id:String(5600000000000000100n+BigInt(i)),name:'原规格',baseFen:6875,discount:95}]}));
 const fixture=await fixtureServer({catalogProducts:products,activePickerProducts:products.slice(0,20).map(p=>p.productId),limited:true,detailObservedPrices:true});
 const at=Math.floor(Date.now()/1000)*1000;
 fixture.state.campaigns.splice(0,1,...[products.slice(0,10),products.slice(10,20),products.slice(20)].map((items,i)=>({
  id:String(4600000000000000100n+BigInt(i)),name:'已有独立活动'+i,type:'限量抢购',status:'进行中',risk:false,autoRenew:true,
  startAt:at-60000,endAt:at+7*86400000-60000,products:structuredClone(items)})));
 const original=structuredClone(fixture.state.campaigns),directory=await mkdtemp(join(tmpdir(),'guardian-active-membership-'));
 const journal=new Journal(join(directory,'guardian.sqlite')),browser=new DedicatedBrowser(join(directory,'browser'),{test:true});
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[products[20].productId]};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy,immediate:true});
 service.canRunImmediate=()=>false;
 try{
  const discovery=await platform.discover({historyReadLimit:0});assert.equal(discovery.activeComplete,true);
  for(const b of discovery.baselines)journal.remember(b);
  const baselines=[...service.latestHistories().values()].filter(b=>!policy.excludedProductIds.includes(b.productId));
  assert.equal(baselines.length,20);service.requestRecovery(baselines.map(b=>b.productId));
  const blocked=[];
  await service.recoverBatch(baselines.map(baseline=>({baseline})),(member,error)=>blocked.push({productId:member.baseline.productId,code:error.code,message:error.message}));
  assert.deepEqual(blocked,[]);
  assert.equal(journal.priceRecheckProgress(policy.shopId).pending,0);assert.equal(journal.priceRecheckProgress(policy.shopId).total,20);
  assert.equal(journal.list(policy.shopId).length,0);assert.equal(journal.priceReviews(policy.shopId).length,0);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.risks,0);assert.ok(fixture.state.prechecks>0);
  assert.deepEqual(fixture.state.campaigns,original);
  const proofs=journal.events(100).filter(e=>e.kind==='active-membership-proof-batch');
  assert.equal(proofs.length,2);assert.equal(proofs.reduce((n,e)=>n+e.detail.productIds.length,0),20);
  await writeFile(resolve('artifacts/beta47-active-membership-browser.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,physicalOtherAccount:false,
   actualPickerDom:true,independentDetailDom:true,requestedProducts:20,independentlyConfirmedProducts:20,sourceCampaigns:2,
   submissions:0,priceApprovals:0,currentValidCampaignsPreserved:true},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-active-membership-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
