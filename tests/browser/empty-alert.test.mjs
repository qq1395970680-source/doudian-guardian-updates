import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {formSlice} from '../../src/platform-snapshot.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
for(const nonempty of [false,true])test(`draft alert placeholder: ${nonempty?'text error still blocks':'empty live region allows original-price recovery'}`,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-alert-')),fixture=await fixtureServer({emptyLiveAlert:true,globalError:nonempty?'价格校验未通过':''});
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'journal.sqlite'));
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(nonempty?1:5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();const task=journal.list(policy.shopId)[0];
  if(nonempty){assert.equal(task.phase,'blocked');assert.match(task.reason,/DRAFT_WARNING/);assert.equal(task.submitAttempts,0);assert.equal(fixture.state.creates,0);}
  else{assert.equal(task.phase,'verified',task.reason);assert.equal(task.receipt.skuCount,50);assert.equal(task.submitAttempts,1);assert.equal(fixture.state.creates,1);}
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',nonempty?'nonempty-alert.json':'empty-alert.json'),JSON.stringify({localFixtureOnly:true,phase:task.phase,receipt:task.receipt||null,submitAttempts:task.submitAttempts,creates:fixture.state.creates},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
test('an empty dialog remains an unresolved dialog rather than an empty alert',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-empty-dialog-')),browser=new DedicatedBrowser(dir,{test:true});
 try{await browser.open('900001');const page=await browser.page();await page.setContent('<div role="alert"> </div><div role="dialog"> </div>');
  const snapshot=await page.evaluate(formSlice);assert.deepEqual(snapshot.warnings,[]);assert.deepEqual(snapshot.dialogs,['']);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
