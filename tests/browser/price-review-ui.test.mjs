import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {openPriceWorkspace,closePriceWorkspace,choosePriceStrategy} from '../helpers/price-workspace-ui.mjs';
import {dualPriceUiFixture} from '../helpers/dual-large-price-ui-fixture.mjs';

for(const width of [1440,960])test('a real double-reduction pair keeps one full price table, fresh consent and read-only history '+width,{timeout:60000},async()=>{
 const x=await dualPriceUiFixture({skuCount:56,mixed:true}),browser=new DedicatedBrowser(join(x.runtime,'ui'),{test:true,viewport:{width,height:960}});
 try{
  await browser.open(x.plan.shopId);const page=await browser.page(),errors=[],posts=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(request.postDataJSON());});
  let connectedShop=x.plan.shopId;await page.route('**/api/status',async route=>{const response=await route.fetch(),status=await response.json();await route.fulfill({json:{...status,connection:{shopId:connectedShop}}});});
  await page.goto(x.app.url);let dialog=await openPriceWorkspace(page,x.plan.productId);await choosePriceStrategy(dialog,'original');let table=dialog.locator('table[data-role="price-target-table"]');
  assert.equal(await table.locator('tbody tr').count(),25);assert.equal(await page.locator('#price-reviews table').count(),0);
  assert.equal(await dialog.locator('[data-scheme-state="reduction-required"]').count(),2,'both classifications come from replayable independent service proofs');
  assert.match(await table.innerText(),/¥66.72/);assert.match(await table.innerText(),/提高 ¥1.39/);assert.match(await table.innerText(),/降低 ¥2.78/);
  assert.match(await dialog.locator('.price-change-summary').innerText(),/调高 1 个规格/);assert.match(await dialog.locator('.price-change-summary').innerText(),/调低 1 个规格/);
  let consent=dialog.locator('.price-consent input'),approve=dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true});assert.equal(await consent.isChecked(),false);assert.equal(await approve.isDisabled(),true);assert.deepEqual(posts,[]);
  await consent.check();await page.evaluate(()=>window.priceRow=document.querySelector('dialog[data-price-workspace] [data-role="price-target-table"] tbody tr'));
  await page.waitForResponse(response=>response.url().includes('/api/price-reviews/item?'),{timeout:12000});
  assert.equal(await page.evaluate(()=>window.priceRow===document.querySelector('dialog[data-price-workspace] [data-role="price-target-table"] tbody tr')),true);assert.equal(await consent.isChecked(),true);
  await dialog.getByRole('button',{name:'下一页规格',exact:true}).click();assert.match(await table.innerText(),/滤芯规格 26/);assert.equal(await consent.isChecked(),true);
  await closePriceWorkspace(page);dialog=await openPriceWorkspace(page,x.plan.productId);await choosePriceStrategy(dialog,'original');consent=dialog.locator('.price-consent input');approve=dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true});assert.equal(await consent.isChecked(),false,'reopening does not carry an unsubmitted approval');
  connectedShop='900002';await page.waitForResponse(response=>response.url().endsWith('/api/status'));await page.waitForFunction(()=>document.querySelector('dialog[data-price-workspace] .price-consent input')?.disabled);assert.equal(await approve.isDisabled(),true);
  connectedShop=x.plan.shopId;await page.waitForResponse(response=>response.url().endsWith('/api/status'));await page.waitForFunction(()=>!document.querySelector('dialog[data-price-workspace] .price-consent input')?.disabled);
  await consent.check();await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`price-review-${width}-consent.png`),fullPage:false});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await approve.click();await dialog.locator('.price-review-heading .badge').filter({hasText:'已确认价格'}).waitFor();
  assert.equal(posts.length,1);assert.equal(posts[0].decision,'approve');assert.equal(posts[0].dualPairKey,x.decision.pairKey);assert.equal(posts[0].acceptBlockedPriceChange,true);assert.equal(posts[0].acceptPriceAndRisk,true);assert.deepEqual(posts[0].confirmedSkuIds,x.plan.skus.map(s=>s.id));
  const target=x.journal.priceTarget(x.plan.shopId,x.plan.productId);assert.equal(target.rows.length,56);assert.equal(target.rows[0].saleFen,6672);assert.equal(target.rows[1].saleFen,7089);assert.equal(x.f.state.submits,0);assert.equal(x.journal.list(x.plan.shopId).length,0);
  await closePriceWorkspace(page);const history=await openPriceWorkspace(page,x.plan.productId,{scope:'history'});assert.equal(await history.locator('.price-consent input,[data-manual-sku]').count(),0);assert.equal(await history.getByRole('button',{name:'重新核对',exact:true}).count(),0);assert.equal(await history.getByRole('button',{name:'手动调整折扣',exact:true}).count(),0);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();}
});
