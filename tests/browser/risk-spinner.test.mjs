import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('native original risk dialog remains confirmable while platform submit portal spins',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-risk-spin-')),fixture=await fixtureServer({riskGlobalSpinner:true}),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'journal.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();const task=journal.list(policy.shopId)[0];
  assert.equal(task.phase,'verified',task.reason);assert.equal(task.receipt.skuCount,50);assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);
  assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  await service.tick();assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/risk-spinner.json'),JSON.stringify({localFixtureOnly:true,viewport:960,receipt:task.receipt,createClicks:fixture.state.creates,submits:fixture.state.submits,risks:fixture.state.risks},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
