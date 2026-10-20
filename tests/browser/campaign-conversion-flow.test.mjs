import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {CampaignConversion} from '../../src/campaign-conversion.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';
for(const scenario of ['original','higher-floor','mixed-lower'])
test(`current promotion conversion preserves authorized price rules: ${scenario}`,{timeout:180000},async()=>{
 const p=fixtureProducts[0],dir=await mkdtemp(join(tmpdir(),'guardian-conversion-')),fixture=await fixtureServer({limited:true,hideDetailRenewal:true,cancelDelayMs:scenario==='original'?1500:0,
  skuPriceFloors:scenario!=='original'?{[p.skus[0].id]:6100}:{},skuPriceCaps:scenario==='mixed-lower'?{[p.skus[1].id]:5900}:{}});
 const prior=fixture.state.campaigns[0];prior.status='进行中';prior.products=prior.products.slice(0,1);
 const browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy}),migration=new CampaignConversion(service);
 try{
  new AccountRegistry(journal).register({shopId:policy.shopId},'signin-fixture');
  setPriceIncreasePolicy(journal,policy.shopId,{enabled:true,acceptHigherPricesAndRisk:true});
  journal.lease(policy.shopId,service.owner,Date.now(),180000);
  await migration.capture({type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}},
   {confirmed:true,source:'human-request',requestId:'fixture-conversion'});
  assert.equal(fixture.state.cancelAttempts,undefined);
  await assert.rejects(()=>service.tick(),{code:'CONVERSION_IN_PROGRESS'});
  await migration.cancel(prior.id);assert.equal(fixture.state.cancelAttempts,1);
  const task=await migration.restore([prior.products[0].productId]);
  if(scenario==='mixed-lower'){
   assert.equal(task.phase,'blocked');assert.equal(fixture.state.submits,0);
   assert.ok(fixture.state.seenPrices.every(s=>s.discount===60));assert.equal(journal.priceReviews(policy.shopId)[0].status,'pending');return;
  }
  assert.equal(task.phase,'verified',task.reason);
  await migration.finish();assert.equal(migration.state().status,'complete');
  assert.equal(migration.state().campaigns[0].confirmAttempts,1);
  assert.equal(fixture.state.campaigns.at(-1).type,'限量抢购');assert.equal(fixture.state.submits,1);
  assert.ok(fixture.state.renewalReads>=2);assert.equal(fixture.state.editWrites,undefined,'renewal readback must never submit the edit form');
  assert.equal(service.latestHistories().get(prior.products[0].productId).skus[0].discount,60);
  if(scenario==='higher-floor'){assert.equal(task.plans[0].skus[0].discount,61);assert.ok(fixture.state.seenPrices.every(s=>s.discount>=60));}
  await migration.cancel(prior.id);assert.equal(fixture.state.cancelAttempts,1);
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
