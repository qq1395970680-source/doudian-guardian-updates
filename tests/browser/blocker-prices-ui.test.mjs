import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {blockerFixture} from '../helpers/blocker-prices-fixture.mjs';
import {activeOriginalPriceRecoveryGrant} from '../../src/original-price-recovery-policy.mjs';

for(const width of [1440,960])test('blocker screen previews exact manual prices and confirms one product only '+width,{timeout:60000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-blocker-editor-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1000}});
 try{
  await browser.open(x.review.shopId);const page=await browser.page(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await page.goto(x.app.url);await page.waitForFunction(()=>document.getElementById('price-count').textContent==='0');
  await page.locator('[data-view="blockers"]').click();await page.locator('[data-blocker-pricing="'+x.review.productId+'"]').click();
  const dialog=page.locator('.blocker-price-dialog');await dialog.locator('[data-price-option="original"]').click();await dialog.locator('.price-consent').waitFor();
  const consent=dialog.locator('.price-consent input'),approve=dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true});
  assert.equal(await consent.isChecked(),false);assert.equal(await approve.isDisabled(),true);assert.match(await dialog.innerText(),/整店仍按原折扣价自动恢复/);
  await dialog.locator('.manual-price-editor summary').click();
  await dialog.locator('[data-manual-sku="'+x.review.rows[0].id+'"]').fill('4.7');await dialog.locator('[data-manual-sku="'+x.review.rows[1].id+'"]').fill('6.1');
  await dialog.getByRole('button',{name:'预览自定义价格',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.blocker-price-dialog [data-price-option="manual-discount"]')?.getAttribute('aria-pressed')==='true');
  assert.match(await dialog.locator('.price-review-body > .price-table-scroll > .price-table').innerText(),/65\.33/);assert.match(await dialog.locator('.price-review-body > .price-table-scroll > .price-table').innerText(),/61\.00/);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
  await consent.check();assert.equal(await approve.isDisabled(),false);
  await dialog.locator('.manual-price-editor summary').click();await dialog.locator('[data-manual-sku="'+x.review.rows[1].id+'"]').fill('6.2');assert.equal(await approve.isDisabled(),true);assert.equal(await consent.isChecked(),false);
  await dialog.getByRole('button',{name:'预览自定义价格',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.blocker-price-dialog .price-review-body > .price-table-scroll > .price-table')?.textContent.includes('62.00'));
  await consent.check();
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`blocker-prices-${width}.png`),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await approve.click();await page.waitForFunction(()=>document.querySelector('.blocker-price-dialog .price-review .badge')?.textContent==='已确认');
  const target=x.journal.priceTarget(x.review.shopId,x.review.productId);assert.deepEqual(target.rows.map(r=>r.discount),[47,62]);assert.equal(target.approvalContext,'recovery-blockers');
  assert.equal(activeOriginalPriceRecoveryGrant(x.journal,x.review.shopId).key,x.grant.key);assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);assert.equal(writes.filter(p=>p.endsWith('/decide')).length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});

test('unknown product remains readable but cannot be approved from blockers',{timeout:45000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-blocker-unknown-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true});
 x.journal.enqueue(x.review.shopId,[x.f.plan],{complete:true,lossKey:'unfinished',observedAt:Date.now()},Date.now());
 try{await browser.open(x.review.shopId);const page=await browser.page();await page.goto(x.app.url);await page.locator('[data-view="blockers"]').click();await page.locator('[data-blocker-pricing="'+x.review.productId+'"]').click();const dialog=page.locator('.blocker-price-dialog');await dialog.locator('[data-pending-price]').waitFor();assert.equal(await dialog.locator('[data-price-option="original"]').isDisabled(),true);assert.equal(await dialog.locator('.price-consent input').count(),0);assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).count(),0);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);}
 finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
