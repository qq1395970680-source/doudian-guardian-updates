import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setOriginalRebuildPolicy} from '../../src/original-rebuild-policy.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {projectBuild} from '../../src/build.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const offShelf of [true,false])test('stale limited-source scope automatically enters a fresh native precheck: offShelf='+offShelf,{timeout:300000},async()=>{
 const target={productId:'3700000000000000101',name:'缓存失效后自动核对商品',activityLimit:888,
  skus:[{id:'5700000000000000101',name:'原规格',baseFen:6875,discount:95}]};
 const other={productId:'3700000000000000102',name:'保留的有效活动商品',activityLimit:1000,
  skus:[{id:'5700000000000000102',name:'其他规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({catalogProducts:[target,other],limited:true,detailObservedPrices:true,offShelfPickerProducts:offShelf?[target.productId]:[]});
 const now=Math.floor(Date.now()/1000)*1000,durationMs=7*86400000;
 Object.assign(fixture.state.campaigns[0],{id:'4700000000000000101',type:'限量抢购',status:'进行中',autoRenew:false,
  startAt:now-60000,endAt:now+durationMs-60000,products:[structuredClone(target)]});
 fixture.state.campaigns.push({id:'4700000000000000102',name:'保留的独立活动',type:'限量抢购',status:'进行中',autoRenew:true,
  startAt:now-60000,endAt:now+durationMs-60000,products:[structuredClone(other)]});
 const directory=await mkdtemp(join(tmpdir(),'guardian-cached-loss-')),journal=new Journal(join(directory,'guardian.sqlite'));
 const registry=new AccountRegistry(journal);registry.register({shopId:'900001',name:'缓存核验测试店'},'shop-900001');registry.authorizeOriginal('900001');
 const policy={...registry.selected(),originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[other.productId]};
 const browser=new DedicatedBrowser(join(directory,'browser'),{test:true}),platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});
 const service=new GuardianService({journal,platform,policy});
 try{
  const initial=await platform.discover({historyReadLimit:0});assert.equal(initial.activeComplete,true);
  for(const b of initial.baselines)journal.remember(b);
  const history=service.latestHistories().get(target.productId);assert.equal(history.rules.autoRenew,false);assert.equal(history.durationMs,durationMs);
  setOriginalRebuildPolicy(journal,policy.shopId,{enabled:true,acceptOriginalRebuild:true});
  const source=fixture.state.campaigns[0];Object.assign(source,{status:'已结束',startAt:now-durationMs-1000,endAt:now-1000});
  const listing=await platform.list(),details=new Map();for(const c of listing.campaigns)details.set(c.id,await platform.detail(c));
  // Reproduce an aged complete cache, not a synthetic permission or absence.
  platform.inventory={listing:{...listing,observedAt:Date.now()-180000},details,activeComplete:true,readOnlyReuseMaxAgeMs:0};
  await assert.rejects(platform.loss(history),error=>error.code==='LIMITED_LOSS_UNPROVEN'&&
   error.detail?.limitedLoss?.productId===target.productId&&!error.detail.limitedLoss.currentAbsence);
  platform.discover=async()=>({activeComplete:true,baselines:[]});
  await service.tick();assert.equal(service.lastRun.ok,true,service.lastRun.message);
  if(offShelf){
   assert.equal(journal.productChecks(policy.shopId).find(c=>c.productId===target.productId)?.code,'OFF_SHELF');
   assert.equal(journal.list(policy.shopId).length,0);assert.equal(fixture.state.submits,0);
  }else{
   const tasks=journal.list(policy.shopId).filter(t=>t.phase==='verified');assert.equal(tasks.length,1,JSON.stringify(journal.productChecks(policy.shopId)));
   assert.equal(tasks[0].lossEvidence.continuities[0].kind,'authorized-original-rebuild');
   assert.equal(tasks[0].receipt.durationMs,durationMs);assert.equal(tasks[0].plans[0].skus[0].saleFen,6532);
   assert.equal(tasks[0].receipt.productLimits[0].activityLimit,888);assert.equal(tasks[0].receipt.autoRenew,false);assert.equal(fixture.state.submits,1);
  }
  assert.equal(journal.priceReviews(policy.shopId).length,0);assert.equal(fixture.state.cancelAttempts||0,0);
  await service.tick();assert.equal(fixture.state.submits,offShelf?0:1);
  if(offShelf)assert.equal(journal.productChecks(policy.shopId).find(c=>c.productId===target.productId)?.code,'OFF_SHELF');
  assert.equal(fixture.state.campaigns[1].status,'进行中');assert.deepEqual(fixture.state.campaigns[1].products,[other]);
  await writeFile(resolve('artifacts',offShelf?'beta50-cached-loss-off-shelf.json':'beta50-cached-loss-restoration.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,physicalOtherAccount:false,
   offShelf,staleNestedProductScopeReproduced:true,freshNativePicker:true,submits:fixture.state.submits,
   perProductPriceApprovals:0,laterPatrolNoDuplicate:true,validOtherActivityPreserved:true},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-cached-loss-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
