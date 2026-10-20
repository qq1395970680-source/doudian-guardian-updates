import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const scenario of ['pure','unknown','mixed'])test('automatic '+scenario+' increase follows shop consent without authorizing any decrease',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-auto-increase-')),product=fixtureProducts[0],mixed=scenario==='mixed';
 const fixture=await fixtureServer({skuPriceFloors:{[product.skus[0].id]:6100},skuPriceCaps:mixed?{[product.skus[1].id]:5900}:{},dropAfterSubmit:scenario==='unknown'});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}}),file=join(dir,'journal.sqlite');
 let journal=new Journal(file);new AccountRegistry(journal).register({shopId:'900001'},'signin-a');setPriceIncreasePolicy(journal,'900001',{enabled:true,acceptHigherPricesAndRisk:true});
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let service;const bind=()=>{service=new GuardianService({journal,platform:new DoudianPlatform({browser,policy,journal,base:fixture.base}),policy});};bind();
 try{
  await service.tick();const review=journal.priceReviews(policy.shopId)[0];assert.ok(review,JSON.stringify(journal.events(10)));
  if(mixed){
   assert.equal(review.status,'pending');assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);
   assert.ok(fixture.state.seenPrices.every(s=>s.discount===60));assert.equal(journal.priceTarget(policy.shopId,product.productId),null);
  }else{
   assert.equal(review.approvalKind,'automatic-price-increase');assert.equal(review.consent,undefined);
   assert.equal(fixture.state.submits,1,JSON.stringify({status:service.status(),events:journal.events(12)}));assert.equal(fixture.state.risks,1);
   assert.ok(fixture.state.seenPrices.every(s=>s.discount>=60));
   if(scenario==='unknown'){
    assert.equal(service.status().unknown,1);service.stop();await browser.close();journal.close();journal=new Journal(file);bind();
    await service.tick();assert.equal(fixture.state.submits,1,'restart reads the unknown result without creating a replacement');
   }
   assert.equal(service.status().verified,1);assert.equal(service.status().unknown,0);
   assert.equal(journal.list(policy.shopId).find(t=>t.phase==='verified').receipt.skuCount,10);
   assert.equal(journal.histories(policy.shopId).find(h=>!h.generatedByGuardian).skus[0].discount,60);
  }
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`automatic-price-increase-${scenario}.json`),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,headless:true,policyConsentFixtureOnly:true,
   mixed,submits:fixture.state.submits,risks:fixture.state.risks,verified:service.status().verified,unknown:service.status().unknown,noFurtherPriceReduction:true,historyPreserved:true},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
