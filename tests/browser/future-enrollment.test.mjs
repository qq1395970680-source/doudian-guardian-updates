import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {projectBuild} from '../../src/build.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const type of ['限时抢购','限量抢购'])test(`later-added ${type} joins an already enrolled shop and retains its own exact prices, seconds and rules`,{timeout:300000},async()=>{
 const limited=type==='限量抢购',durationMs=limited?2419207000:48*3600000+7000;
 const products=Array.from({length:2},(_,i)=>({productId:String(3000000000000000100n+BigInt(i)),name:i?'后续新增商品':'首次已有商品',
  skus:[{id:String(5000000000000000100n+BigInt(i*10)),name:'低价规格',baseFen:6875,discount:95},
   {id:String(5000000000000000101n+BigInt(i*10)),name:'中价规格',baseFen:10000,discount:82},
   {id:String(5000000000000000102n+BigInt(i*10)),name:'高价规格',baseFen:13000,discount:55}]}));
 const fixture=await fixtureServer({catalogProducts:products,limited,hideDetailRenewal:true,detailObservedPrices:true});
 const initial=fixture.state.campaigns[0],start=Math.floor(Date.now()/1000)*1000-60000;
 Object.assign(initial,{type,status:'进行中',autoRenew:limited,startAt:start,endAt:start+7*86400000,products:[{...structuredClone(products[0]),...(limited?{activityLimit:750}:{})}]});
 const dir=await mkdtemp(join(tmpdir(),'guardian-future-enroll-')),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 const accounts=new AccountRegistry(journal);accounts.register({shopId:'900001',name:'后续活动隔离测试'},'shop-900001');
 const policy={...accounts.authorizeOriginal('900001'),liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();assert.equal(service.lastRun.ok,true,service.lastRun.message);assert.equal(journal.histories(policy.shopId).length,1);assert.equal(fixture.state.submits,0);
  assert.equal(service.latestHistories().has(products[1].productId),false,'not-yet-promoted products cannot enter history from the picker catalog');
  const futureStart=Math.floor(Date.now()/1000)*1000-10000;
  const future={id:'4000000000000000099',name:'登录之后新增的活动',type,status:'进行中',startAt:futureStart,endAt:futureStart+durationMs,
   autoRenew:limited,products:[{...structuredClone(products[1]),...(limited?{activityLimit:888}:{})}]};
  fixture.state.campaigns.push(future);
  await service.tick();assert.equal(service.lastRun.ok,true,service.lastRun.message);
  const baseline=service.latestHistories().get(products[1].productId);assert.ok(baseline);assert.equal(baseline.campaignId,future.id);assert.equal(baseline.durationMs,durationMs);
  assert.equal(baseline.type,type);assert.deepEqual(baseline.skus.map(s=>[s.id,s.baseFen,s.discount]),products[1].skus.map(s=>[s.id,s.baseFen,s.discount]));
  assert.equal(journal.list(policy.shopId).length,0);assert.equal(fixture.state.submits,0);
  Object.assign(future.products[0],{removalConfirmed:true,removalRiskConfirmed:true});future.risk=true;
  await service.tick();
  const task=journal.list(policy.shopId).find(t=>t.plans.some(p=>p.productId===products[1].productId));
  assert.equal(task?.phase,'verified',JSON.stringify({status:service.status(),checks:journal.productChecks(policy.shopId)}));
  assert.equal(task.plans.length,1);assert.equal(task.plans[0].type,type);assert.equal(task.receipt.durationMs,durationMs);assert.equal(task.receipt.skuCount,3);
  const created=fixture.state.campaigns.find(c=>c.id===task.receipt.campaignId);assert.ok(created);
  const independent=await platform.detail(created);assert.equal(independent.complete,true);assert.deepEqual(independent.products[0].skus.map(s=>[s.id,s.baseFen,s.discount,s.saleFen,s.saleSource]),
   [[products[1].skus[0].id,6875,95,6532,'observed'],[products[1].skus[1].id,10000,82,8200,'observed'],[products[1].skus[2].id,13000,55,7150,'observed']]);
  if(limited){assert.equal(task.receipt.productLimits[0].activityLimit,888);assert.equal(task.receipt.autoRenew,true);assert.ok(fixture.state.renewalReads>0);}
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.uploads,1);assert.equal(fixture.state.risks,1);
  await service.tick();assert.equal(fixture.state.submits,1,'a later patrol must not recreate the already verified activity');
  if(limited){Object.assign(created.products[0],{removalConfirmed:true,soldOut:true});await service.tick();assert.equal(fixture.state.submits,1,'sold-out quantity must not be replenished as an abnormal removal');}
  assert.equal(fixture.state.cancelAttempts||0,0);assert.equal(initial.status,'进行中');assert.equal(initial.products[0].productId,products[0].productId);
  const proof={at:new Date().toISOString(),sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,physicalOtherAccount:false,type,durationMs,
   laterAddedWithoutReregister:true,notCapturedBeforeFirstPromotion:true,exactMixedDiscounts:[95,82,55],observedSaleFen:[6532,8200,7150],
   independentlyVerifiedSkus:3,submitCount:1,laterPatrolNoDuplicate:true,limitedQuantity:limited?888:null,limitedSoldOutNotReplenished:limited,validInitialActivityNotCancelled:true};
  await writeFile(resolve('artifacts',limited?'future-enrollment-limited.json':'future-enrollment-timed.json'),JSON.stringify(proof,null,2)+'\n');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
