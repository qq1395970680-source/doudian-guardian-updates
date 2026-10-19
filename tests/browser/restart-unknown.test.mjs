import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
test('unknown commit survives closed browser and reopened journal without another create click',{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-restart-unknown-')),fixture=await fixtureServer({dropAfterSubmit:true}),path=join(dir,'journal.sqlite');
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(path),platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();assert.equal(service.status().unknown,1);assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  const original=journal.list(policy.shopId)[0];assert.equal(original.submitAttempts,1);
  service.stop();await browser.close();journal.close();
  browser=new DedicatedBrowser(dir,{test:true,viewport:{width:1440,height:960}});journal=new Journal(path);platform=new DoudianPlatform({browser,journal,policy,base:fixture.base});service=new GuardianService({journal,platform,policy});
  await service.tick();const recovered=journal.get(original.id);
  assert.equal(recovered.phase,'verified');assert.equal(recovered.submitAttempts,1);assert.equal(recovered.receipt.skuCount,10);assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','restart-unknown.json'),JSON.stringify({localFixtureOnly:true,browserAndJournalReopened:true,viewports:[960,1440],taskId:original.id,phase:recovered.phase,createClicks:fixture.state.creates,submits:fixture.state.submits,receipt:recovered.receipt},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
