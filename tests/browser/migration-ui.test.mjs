import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {makeTransfer} from '../../src/migration.mjs';
import {priceFixture} from '../helpers/price-review-fixture.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

test('migration UI previews SKU history, requires a separate unchecked choice and uses native save bridge',{timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-migration-ui-')),source=new Journal(':memory:'),target=new Journal(':memory:'),browser=new DedicatedBrowser(join(root,'ui'),{test:true,viewport:{width:960,height:960}});
 const f=priceFixture(source,Date.now()),file=makeTransfer(source,{...f.policy,name:'迁移测试店'},{version:'2.0.0-beta.6'});
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){this.running=false;}};
 const app=await createApp({config:{shopId:f.policy.shopId},runtime:join(root,'server'),port:0,dependencies:{journal:target,service,browser:{close:async()=>{}},platform:{probe:async()=>({shopId:f.policy.shopId,name:'迁移测试店'}),progress:{}}}});
 try{await browser.open(f.policy.shopId);const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.evaluate(file=>{window.guardianDesktop={chooseTransfer:async()=>({file}),saveTransfer:async saved=>{window.savedTransfer=saved;return{saved:true};}};},file);
  await page.locator('[data-view="accounts"]').click();await page.locator('#finish-login').click();await page.waitForFunction(()=>!document.getElementById('choose-transfer').disabled);
  await page.locator('#choose-transfer').click();await page.locator('#transfer-preview').waitFor({state:'visible'});
  assert.equal(target.histories(f.policy.shopId).length,0);assert.equal(await page.locator('#transfer-consent').isChecked(),false);assert.equal(await page.locator('#import-transfer').isDisabled(),true);
  await page.locator('.transfer-product summary').click();assert.equal(await page.locator('.transfer-product tbody tr').count(),2);assert.match(await page.locator('#transfer-products').innerText(),/69.50/);
  await page.locator('#transfer-consent').check();await page.waitForResponse(r=>r.url().endsWith('/api/status'));assert.equal(await page.locator('#transfer-consent').isChecked(),true);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/migration-preview.png'),fullPage:false});
  await page.locator('#import-transfer').click();await page.waitForFunction(()=>document.getElementById('transfer-preview').hidden);assert.equal(target.histories(f.policy.shopId).length,1);assert.equal(service.running,false);
  await page.locator('#export-transfer').click();await page.waitForFunction(()=>!!window.savedTransfer);assert.equal(await page.evaluate(()=>window.savedTransfer.payload.histories.length),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();source.close();await rm(root,{recursive:true,force:true});}
});
