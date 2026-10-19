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

for(const unknown of [false,true])test('headless price limit requires exact consent, then readback; restart unknown='+unknown,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-price-flow-')),product=fixtureProducts[0],sid=product.skus[0].id;
 const fixture=await fixtureServer({skuPriceCaps:{[sid]:5800},dropAfterSubmit:unknown}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}});
 let journal=new Journal(join(dir,'journal.sqlite'));
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();let review=journal.priceReviews(policy.shopId)[0];assert.ok(review,JSON.stringify({status:service.status(),events:journal.events(5)}));
  assert.equal(review.status,'pending');assert.equal(review.rows.length,10);assert.equal(review.rows[0].discount,58);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);
  await service.tick();assert.equal(fixture.state.submits,0);assert.ok(fixture.state.seenPrices.every(r=>r.discount===60),'no lower price can be filled before consent');
  service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true});
  await service.tick();assert.equal(fixture.state.submits,1,JSON.stringify({status:service.status(),events:journal.events(8)}));assert.equal(fixture.state.risks,1);
  if(unknown){
   assert.equal(service.status().unknown,1);service.stop();await browser.close();journal.close();journal=new Journal(join(dir,'journal.sqlite'));
   platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});service=new GuardianService({journal,platform,policy});
   await service.tick();assert.equal(fixture.state.submits,1,'restart must only read the unknown result');
  }
  assert.equal(service.status().verified,1,JSON.stringify(service.status()));assert.equal(journal.list(policy.shopId).find(t=>t.phase==='verified').receipt.skuCount,10);
  assert.equal(journal.histories(policy.shopId).find(h=>!h.generatedByGuardian).skus[0].discount,60);
  await service.tick();assert.equal(fixture.state.submits,1);
  if(!unknown){
   // Local test platform only: simulate another natural loss with a lower cap.
   fixture.state.campaigns.find(c=>c.name.startsWith('守护2')).status='已失效';fixture.state.skuPriceCaps[sid]=5600;
   await service.tick();const next=journal.priceReviews(policy.shopId).find(r=>r.status==='pending');
   assert.ok(next,JSON.stringify(journal.events(6)));assert.equal(next.rows[0].previousDiscount,58);assert.equal(next.rows[0].discount,56);assert.equal(next.previousApprovalId,review.id);
   assert.equal(fixture.state.submits,1);assert.ok(fixture.state.seenPrices.every(r=>r.discount>=58));
  }
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`price-review-flow-${unknown?'unknown':'confirmed'}.json`),JSON.stringify({localFixtureOnly:true,headless:true,submits:fixture.state.submits,risks:fixture.state.risks,verified:service.status().verified,unknown:service.status().unknown,historyPreserved:true,requiresExactConsent:true,restartUnknown:unknown},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
