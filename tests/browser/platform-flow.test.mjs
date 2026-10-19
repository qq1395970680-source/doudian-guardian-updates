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

for(const viewport of [{width:1440,height:960},{width:960,height:600}])test(`real headless full adapter: 5 products, 50 SKUs, native risk click and independent detail at ${viewport.width}`,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-flow-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(dir,{test:true,viewport});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{
  await service.tick();const status=service.status();
  assert.equal(status.verified,5,JSON.stringify({status,events:journal.events(8)},null,2));
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);assert.equal(fixture.state.uploads,1);assert.equal(fixture.state.modeWarnings,0);
  const task=journal.list('900001')[0];assert.equal(task.receipt.skuCount,50);assert.equal(task.riskAttempts,1);assert.equal(task.submitAttempts,1);
  await service.tick();assert.equal(fixture.state.submits,1,'next patrol must not recreate active products');
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`headless-flow-${viewport.width}.json`),JSON.stringify({localFixtureOnly:true,viewport,status:service.status(),nativeBrowser:true,platformStats:fixture.state.submits,task},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

for(const mode of ['corruptPrice','dropAfterSubmit','abortBeforeHeaders'])test(`full adapter blocks unsafe replay: ${mode}`,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-failure-')),fixture=await fixtureServer({[mode]:true}),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{
  await service.tick();
  if(mode==='corruptPrice'){
   assert.equal(service.status().blocked,1,JSON.stringify(service.status()));assert.equal(fixture.state.creates,0);assert.equal(fixture.state.submits,0);
  }else if(mode==='dropAfterSubmit'){
   assert.equal(service.status().unknown,1,JSON.stringify(service.status()));assert.equal(fixture.state.submits,1);
   await service.tick();assert.equal(service.status().verified,1);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);assert.equal(platform.drafts.size,0);
  }else{
   assert.equal(service.status().unknown,1);const requests=fixture.state.submits;assert.ok(requests>=1);
   assert.equal(fixture.state.creates,1);await service.tick();assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,requests);
   if(requests>1){assert.equal(service.status().unknown,1);assert.ok(journal.events(100).some(e=>e.detail.code==='DUPLICATE_CAMPAIGN'));}
   else assert.equal(service.status().verified,1);
  }
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',mode+'.json'),JSON.stringify({localFixtureOnly:true,status:service.status(),submits:fixture.state.submits,creates:fixture.state.creates},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
