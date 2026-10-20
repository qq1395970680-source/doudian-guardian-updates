import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const mixed of [false,true])test('headless higher/mixed exact-price consent and restart readback: mixed='+mixed,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-higher-flow-')),product=fixtureProducts[0];
 const fixture=await fixtureServer({skuPriceFloors:{[product.skus[0].id]:6100},skuPriceCaps:mixed?{[product.skus[1].id]:5900}:{},dropAfterSubmit:mixed});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:mixed?960:1440,height:960}}),journalPath=join(dir,'journal.sqlite');
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let journal=new Journal(journalPath),platform,service;
 const bind=()=>{platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});service=new GuardianService({journal,platform,policy});};bind();
 try{
  await service.tick();const review=journal.priceReviews(policy.shopId)[0];
  assert.ok(review,JSON.stringify(journal.events(8)));assert.equal(review.status,'pending');assert.equal(review.rows.length,10);
  assert.equal(review.rows[0].discount,61);assert.equal(review.rows[0].saleFen,6100);
  assert.equal(review.rows[1].discount,mixed?58:60);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);
  assert.ok(fixture.state.seenPrices.every(s=>s.discount===60),'no changed candidate may be filled before explicit consent');
  service.stop();await browser.close();journal.close();journal=new Journal(journalPath);bind();
  assert.equal(journal.priceReview(review.id).status,'pending');assert.equal(journal.priceTarget(review.shopId,review.productId),null);
  assert.throws(()=>service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:[review.rows[0].id],acceptPriceAndRisk:true}),{code:'PRICE_CONSENT_REQUIRED'});
  service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:review.rows.map(s=>s.id),acceptPriceAndRisk:true});
  await service.tick();assert.equal(fixture.state.submits,1,JSON.stringify(journal.events(10)));assert.equal(fixture.state.risks,1);
  if(mixed){
   assert.equal(service.status().unknown,1);service.stop();await browser.close();journal.close();journal=new Journal(journalPath);bind();
   await service.tick();assert.equal(fixture.state.submits,1,'unknown result must only be read after restart');
  }
  assert.equal(service.status().verified,1);assert.equal(service.status().unknown,0);
  const verified=journal.list(policy.shopId).find(t=>t.phase==='verified');assert.equal(verified.receipt.skuCount,10);
  assert.equal(verified.plans[0].skus[0].discount,61);assert.equal(verified.plans[0].skus[1].discount,mixed?58:60);
  assert.equal(journal.histories(policy.shopId).find(h=>!h.generatedByGuardian).skus[0].discount,60);
  await service.tick();assert.equal(fixture.state.submits,1);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`price-increase-flow-${mixed?'mixed-unknown':'higher-confirmed'}.json`),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,headless:true,realPriceChange:false,requiresAllSkuConsent:true,
   submits:fixture.state.submits,risks:fixture.state.risks,verified:service.status().verified,unknown:service.status().unknown,historyPreserved:true,pendingSurvivesRestart:true,unknownRestart:mixed},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
