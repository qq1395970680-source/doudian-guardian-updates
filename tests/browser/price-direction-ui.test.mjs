import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {dualPriceUiFixture} from '../helpers/dual-large-price-ui-fixture.mjs';
import {ratioFixture} from '../helpers/ratio-review-fixture.mjs';
import {openPriceWorkspace,closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';

for(const width of [960,1440])test('only two proven reductions require consent; other price facts remain automatic '+width,{timeout:60000},async()=>{
 const x=await dualPriceUiFixture(),other=ratioFixture(x.journal,{now:Date.now()-500,productId:'300002'});x.journal.recordRemovalPriceReview(other.plan,other.loss,Date.now()-500);
 const browser=new DedicatedBrowser(join(x.runtime,'ui'),{test:true,viewport:{width,height:960}});
 try{
  await browser.open(x.plan.shopId);const page=await browser.page(),errors=[],posts=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(request.postDataJSON());});await page.goto(x.app.url);
  let dialog=await openPriceWorkspace(page,x.plan.productId);assert.equal(await page.locator('#workspace-confirm-count').innerText(),'1');assert.equal(await page.locator('#price-count').innerText(),'1');assert.equal(await page.locator('#price-reviews [data-workspace-product="300002"]').count(),0);
  const select=dialog.getByRole('combobox',{name:'选择价格调整方案',exact:true});assert.equal(await select.locator('option[value="raise-low"]').evaluate(option=>option.disabled),true);const before=await select.inputValue();await select.focus();await select.press('End');assert.equal(await select.inputValue(),before);
  assert.equal(await dialog.locator('table[data-role="price-target-table"] tbody tr').count(),2);assert.equal(await dialog.locator('.price-consent input').isChecked(),false);assert.equal(x.journal.priceTarget(x.plan.shopId,x.plan.productId),null);
  await dialog.locator('.price-consent input').check();await dialog.locator('[data-activity-price-type="限时抢购"] [data-activity-price-choice]').click();assert.equal(await dialog.locator('.price-consent input').isChecked(),false,'changing the activity clears consent');assert.match(await dialog.locator('.price-consent').innerText(),/限时抢购/);assert.equal(await dialog.locator('.price-strategy-select').evaluate(select=>select.selectedOptions[0].textContent),'按平台要求调整');assert.doesNotMatch(await dialog.locator('.price-strategy-select').innerText(),/算法/);
  await closePriceWorkspace(page);const automatic=await openPriceWorkspace(page,'300002',{scope:'automatic'});assert.equal(await automatic.locator('.price-consent input,[data-manual-sku]').count(),0);assert.equal(await automatic.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).count(),0);assert.deepEqual(posts,[]);await closePriceWorkspace(page);
  dialog=await openPriceWorkspace(page,x.plan.productId);assert.equal(await dialog.locator('.price-consent input').isChecked(),false);await dialog.locator('[data-activity-price-type="限时抢购"] [data-activity-price-choice]').click();await dialog.locator('.price-consent input').check();await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).click();await dialog.locator('.price-review-heading .badge').filter({hasText:'已确认价格'}).waitFor();
  const target=x.journal.priceTarget(x.plan.shopId,x.plan.productId);assert.equal(target.type,'限时抢购');assert.deepEqual(target.rows.map(s=>s.discount),[59,49]);assert.equal(posts.length,1);assert.equal(posts[0].dualPairKey,x.decision.pairKey);assert.deepEqual(posts[0].confirmedSkuIds,x.plan.skus.map(s=>s.id));assert.equal(x.journal.priceTarget(x.plan.shopId,'300002'),null);assert.equal(x.journal.list(x.plan.shopId).length,0);assert.equal(x.f.state.submits,0);
  await closePriceWorkspace(page);await page.locator('[data-workspace-scope="history"]').click();await page.locator('#price-reviews [data-workspace-product="'+x.plan.productId+'"]').waitFor();assert.equal(await page.locator('#price-reviews table,.price-consent input').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();}
});
