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

const badge='<div class="ecom-mcenter-sp-tag ecom-mcenter-sp-tag-wrapper"><div class="sp-tag-content">上次选择</div></div>';
const header=(mode,tag=badge)=>'<th><span class="ecom-mcenter-select-selection-item"><div>'+mode+tag+'</div></span></th>';
test('price mode reads the selected value independently of the exact last-choice badge',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-price-mode-')),browser=new DedicatedBrowser(dir,{test:true});
 try{await browser.open('900001');const page=await browser.page();
  for(const [markup,expected,label] of [
   [header('打折'),true,'observed remembered selection'],
   [header('打折',''),true,'first selection'],
   [header('一口价'),false,'wrong mode with remembered badge'],
   [header('打折','<div class="ecom-mcenter-sp-tag">未知状态</div>'),false,'unknown tag must remain material'],
   [header('打折','<span>上次选择</span>'),false,'unrecognized decoration'],
   [header('打折')+header('一口价'),false,'conflicting modes'],
   [header('打折')+header('打折'),false,'ambiguous duplicate controls'],
   ['<th><div hidden><span class="ecom-mcenter-select-selection-item">打折</span></div></th>',false,'hidden stale header'],
  ]){await page.setContent('<table><tr>'+markup+'</tr></table>');assert.equal((await page.evaluate(formSlice)).byDiscount,expected,label);}
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

for(const viewport of [{width:1440,height:960},{width:960,height:600}])test(`remembered discount badge: native headless batch and independent readback at ${viewport.width}`,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-remembered-')),fixture=await fixtureServer({rememberedPriceMode:true,riskGlobalSpinner:true}),browser=new DedicatedBrowser(dir,{test:true,viewport});
 const journal=new Journal(join(dir,'journal.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();const task=journal.list(policy.shopId)[0];
  assert.equal(task.phase,'verified',task.reason);assert.equal(task.receipt.skuCount,50);assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);
  assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  await service.tick();assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve(`artifacts/remembered-price-mode-${viewport.width}.json`),JSON.stringify({localFixtureOnly:true,viewport,receipt:task.receipt,createClicks:fixture.state.creates,submits:fixture.state.submits,risks:fixture.state.risks},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
