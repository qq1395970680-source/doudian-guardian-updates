import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {dualBlockerFixture as blockerFixture,openDualPriceWorkspace as openPriceWorkspace} from '../helpers/dual-price-ui-fixture.mjs';

for(const width of [1440,960])test('two type reasons and distinct per-SKU adjustments remain selectable only with fresh explicit consent '+width,{timeout:60000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-two-types-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1080}});
 try{
  await browser.open(x.review.shopId);const page=await browser.page(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});await page.goto(x.app.url);
  const dialog=await openPriceWorkspace(page,x.review.productId),timed=dialog.locator('[data-activity-price-type="限时抢购"]'),limited=dialog.locator('[data-activity-price-type="限量抢购"]');await timed.waitFor();await limited.waitFor();
  assert.match(await timed.innerText(),/不高于 ¥68\.00/);assert.match(await limited.innerText(),/不高于 ¥65\.00/);
  assert.match(await timed.innerText(),/调低\s+1\s+个/);assert.match(await limited.innerText(),/调低\s+1\s+个/);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
  assert.equal(await timed.getAttribute('data-scheme-state'),'reduction-required');assert.equal(await limited.getAttribute('data-scheme-state'),'reduction-required');
  assert.equal(await dialog.locator('[data-activity-price-type] table').count(),0);assert.equal(await dialog.locator('table').count(),1);
  await timed.locator('[data-activity-price-choice]').click();const table=dialog.locator('table[data-role="price-target-table"]');assert.match(await table.innerText(),/66\.72/);assert.match(await table.innerText(),/降低 ¥2\.78/);
  await dialog.locator('.price-consent input').check();
  await limited.locator('[data-activity-price-choice]').click();assert.match(await table.innerText(),/63\.94/);assert.match(await table.innerText(),/降低 ¥5\.56/);
  const selectedLabel=await dialog.locator('.price-strategy-select option:checked').innerText();assert.match(selectedLabel,/按平台要求调整/);assert.doesNotMatch(selectedLabel,/算法/);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`activity-prices-${width}.png`),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const consent=dialog.locator('.price-consent input');assert.equal(await consent.isChecked(),false);assert.match(await dialog.locator('.price-consent').innerText(),/限量抢购/);
  assert.deepEqual(posts,[]);await consent.check();await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).click();await page.waitForFunction(()=>document.querySelector('dialog[data-price-workspace] .price-review-heading .badge')?.textContent==='已确认价格');
  assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId).type,'限量抢购');assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId).rows[0].discount,46);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
