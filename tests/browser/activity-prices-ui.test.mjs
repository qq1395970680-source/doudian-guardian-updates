import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {blockerFixture} from '../helpers/blocker-prices-fixture.mjs';
import {seedLimitedRejection} from '../helpers/activity-price-fixture.mjs';

for(const width of [1440,960])test('two type reasons and distinct per-SKU adjustments remain selectable only with fresh explicit consent '+width,{timeout:60000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-two-types-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1080}});seedLimitedRejection(x.journal,x.f,x.review);
 try{
  await browser.open(x.review.shopId);const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(x.app.url);await page.locator('[data-view="blockers"]').click();await page.locator('[data-blocker-pricing="'+x.review.productId+'"]').click();
  const dialog=page.locator('.blocker-price-dialog'),timed=dialog.locator('[data-activity-price-type="限时抢购"]'),limited=dialog.locator('[data-activity-price-type="限量抢购"]');await timed.waitFor();await limited.waitFor();
  assert.match(await timed.innerText(),/不高于 ¥68\.00/);assert.match(await timed.innerText(),/¥66\.72/);assert.match(await limited.innerText(),/不低于 ¥72\.00/);assert.match(await limited.innerText(),/¥72\.28/);
  assert.match(await timed.innerText(),/调低 1 个规格/);assert.match(await limited.innerText(),/调高 1 个规格/);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`activity-prices-${width}.png`),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await limited.getByRole('button',{name:'选择限量抢购价格方案',exact:true}).click();const table=dialog.locator('.price-review-body > .price-table-scroll > .price-table');assert.match(await table.innerText(),/72\.28/);
  const consent=dialog.locator('.price-consent input');assert.equal(await consent.isChecked(),false);assert.match(await dialog.locator('.price-consent').innerText(),/限量抢购/);
  await consent.check();await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.blocker-price-dialog .price-review .badge')?.textContent==='已确认');
  assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId).type,'限量抢购');assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId).rows[0].discount,52);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
