import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {continueRetainedRisks} from '../../src/maintenance.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const scenario of ['continue','changed-price','lost-page'])test('retained original risk maintenance: '+scenario,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-retained-risk-')),fixture=await fixtureServer({riskGlobalSpinner:true,riskFormSpinner:true}),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'journal.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();const original=journal.list(policy.shopId)[0];
  assert.equal(original.phase,'unknown');assert.equal(original.submitAttempts,1);assert.equal(original.riskAttempts,0);assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,0,'real form validation must still block confirmation');
  service.stop();platform.stopping=true;
  const page=platform.drafts.get(original.id);
  if(scenario==='lost-page')await page.close();
  else await page.evaluate(change=>{document.querySelector('#fixture-form-validation').remove();if(change){state.selected[0].skus[0].discount=55;render();}},scenario==='changed-price');
  const result=await continueRetainedRisks(service,{candidateBuild:'a'.repeat(64)}),current=journal.get(original.id);
  assert.equal(fixture.state.creates,1,'maintenance never repeats main submit');assert.equal(current.submitAttempts,1);assert.equal(service.busy,false);assert.equal(service.running,false);
  if(scenario==='continue'){
   assert.equal(current.phase,'verified',JSON.stringify(result));assert.equal(current.riskAttempts,1);assert.equal(fixture.state.submits,1);assert.equal(current.receipt.skuCount,10);
   await continueRetainedRisks(service,{candidateBuild:'a'.repeat(64)});assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);
  }else{assert.equal(current.phase,'unknown');assert.equal(current.riskAttempts,0);assert.equal(fixture.state.submits,0);}
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`retained-risk-${scenario}.json`),JSON.stringify({localFixtureOnly:true,result,phase:current.phase,createClicks:fixture.state.creates,submits:fixture.state.submits,riskAttempts:current.riskAttempts},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
