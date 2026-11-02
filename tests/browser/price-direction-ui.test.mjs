import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {createApp} from '../../src/server.mjs';
import {GuardianService} from '../../src/service.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {ratioFixture} from '../helpers/ratio-review-fixture.mjs';
import {openPriceWorkspace,choosePriceStrategy,closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';

for(const width of [960,1440])test('price direction filters retain whole-product explicit consent in one drawer '+width,{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-direction-ui-')),j=new Journal(':memory:'),now=Date.now();
 const up=ratioFixture(j,{now}),down=ratioFixture(j,{now,mixed:true,productId:'300002'});
 const increase=j.recordRemovalPriceReview(up.plan,up.loss,now),decrease=j.recordRemovalPriceReview(down.plan,down.loss,now);
 const platform={progress:{stage:'test'},probe:async()=>({shopId:up.policy.shopId,name:'调价分区测试店'})};
 const service=new GuardianService({journal:j,platform,policy:up.policy});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width,height:960}});
 const app=await createApp({config:up.policy,runtime:join(dir,'server'),port:0,dependencies:{journal:j,service,platform,browser:{close:async()=>{}}}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  for(let i=0;i<50&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
  await browser.open(up.policy.shopId);const page=await browser.page(),errors=[],posts=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.postDataJSON());});await page.goto(app.url);
  const upDrawer=await openPriceWorkspace(page,increase.productId,{direction:'increase'});
  assert.equal(await page.locator('#price-increase-count').innerText(),'1');assert.equal(await page.locator('#price-decrease-count').innerText(),'1');
  assert.equal(await page.locator('#price-reviews [data-price-product="'+decrease.productId+'"]').count(),0);
  await upDrawer.locator('.price-consent input').check();await choosePriceStrategy(upDrawer,'raise-low');
  assert.equal(await upDrawer.locator('.price-consent input').isChecked(),false,'changing strategy clears consent');
  const upItem=await(await fetch(app.url+'/api/price-reviews/item?productId='+increase.productId)).json();assert.equal(upItem.review.options.length,4);
  await closePriceWorkspace(page);const downDrawer=await openPriceWorkspace(page,decrease.productId,{direction:'decrease'});
  assert.equal(await page.locator('#price-reviews [data-price-product="'+increase.productId+'"]').count(),0);
  const downSelect=downDrawer.getByRole('combobox',{name:'选择价格调整方案',exact:true});
  // Check the native option flag and keyboard behavior. Playwright's option
  // helpers retarget disabled checks or programmatically select blocked items.
  assert.equal(await downSelect.locator('option[value="raise-low"]').evaluate(option=>option.disabled),true);const selectedBefore=await downSelect.inputValue();
  await downSelect.focus();await downSelect.press('End');assert.equal(await downSelect.inputValue(),selectedBefore);
  const limited=downDrawer.locator('[data-activity-price-type="限量抢购"]');await limited.locator('.activity-evidence > summary').click();assert.match(await limited.innerText(),/没有满足条件的不降价方案/,'unavailable non-decreasing strategies retain an explanation in the corresponding activity');
  assert.equal(await downDrawer.locator('.price-consent input').isChecked(),false);assert.equal(j.priceTarget(up.policy.shopId,decrease.productId),null,'displaying a lower candidate is not approval');
  const downItem=await(await fetch(app.url+'/api/price-reviews/item?productId='+decrease.productId)).json();assert.match(downItem.review.options.find(o=>o.id==='switch-original').reason,/尚未通过目标活动/);
  await choosePriceStrategy(downDrawer,'original');const table=downDrawer.locator('table[data-role="price-target-table"]');assert.equal(await table.locator('tbody tr').count(),2);
  assert.match(await downDrawer.locator('.price-lower-warning').innerText(),/¥95.57/);assert.equal(await downDrawer.locator('.price-consent input').isChecked(),false);
  assert.deepEqual(posts,[]);await page.screenshot({path:join(import.meta.dirname,`../../artifacts/beta59-price-decrease-${width}.png`)});
  await closePriceWorkspace(page);const again=await openPriceWorkspace(page,increase.productId,{direction:'increase'});
  assert.equal(await again.locator('.price-consent input').isChecked(),false,'switching views and reopening never preserves unsubmitted consent');
  await page.screenshot({path:join(import.meta.dirname,`../../artifacts/beta59-price-increase-${width}.png`)});
  await again.locator('.price-consent input').check();await again.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('dialog[data-price-workspace] .price-review-heading .badge')?.textContent==='已确认价格');await closePriceWorkspace(page);
  await page.locator('[data-price-direction="increase"]').click();await page.waitForFunction(()=>document.querySelector('#price-increase-count').textContent==='0');
  assert.equal(j.priceTarget(up.policy.shopId,increase.productId)?.id,increase.id);assert.equal(j.priceTarget(up.policy.shopId,decrease.productId),null);
  const lower=await openPriceWorkspace(page,decrease.productId,{direction:'decrease'});await choosePriceStrategy(lower,'original');await lower.locator('.price-consent input').check();await lower.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('dialog[data-price-workspace] .price-review-heading .badge')?.textContent==='已确认价格');await closePriceWorkspace(page);
  await page.locator('[data-price-direction="decrease"]').click();await page.waitForFunction(()=>document.querySelector('#price-decrease-count').textContent==='0');
  assert.equal(j.priceTarget(up.policy.shopId,decrease.productId)?.id,decrease.id);assert.equal(posts.length,2);assert.deepEqual(posts[1].confirmedSkuIds,decrease.rows.map(r=>r.id));
  assert.equal(posts.every(p=>p.acceptPriceAndRisk===true&&p.acceptBlockedPriceChange===true),true);
  await page.locator('[data-price-scope="history"]').click();await page.waitForFunction(()=>document.querySelectorAll('#price-reviews [data-price-product]').length===2);
  assert.equal(await page.locator('#price-reviews .price-consent input').count(),0);assert.equal(await page.locator('#price-reviews table').count(),0);
  assert.equal(j.list(up.policy.shopId).length,0,'confirmation records exact consent, not a platform submit');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
