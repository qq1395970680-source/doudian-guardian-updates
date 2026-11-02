import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {blockerFixture} from '../helpers/blocker-prices-fixture.mjs';
import {closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';

test('async scope switches withdraw old rows and keep history read-only without changing the live pending decision',{timeout:45000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-history-scope-race-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:960,height:1000}});
 const approved={...structuredClone(x.review),id:'older-approved-history',key:'older-approved-history-key',status:'approved',createdAt:x.review.createdAt-60000,expiresAt:x.review.createdAt-1000};
 x.journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(approved.id,approved.shopId,approved.productId,approved.status,JSON.stringify(approved),approved.createdAt);
 let release;
 try{
  await browser.open(x.review.shopId);const page=await browser.page(),posts=[],errors=[],items=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);if(request.url().includes('/api/price-reviews/item?'))items.push(new URL(request.url()));});
  let holdScope=null,held;const hold=scope=>{holdScope=scope;const started=new Promise(resolve=>{held=resolve;});const gate=new Promise(resolve=>{release=resolve;});return{started,gate};};
  let gate;
  await page.route(/\/api\/price-reviews\?/,async route=>{if(new URL(route.request().url()).searchParams.get('scope')===holdScope){const next=gate;held();await next;}await route.continue();});
  await page.goto(x.app.url);await page.locator('[data-view="prices"]').click();await page.locator('#price-reviews [data-review-id="'+x.review.id+'"]').waitFor();
  let delayed=hold('history');gate=delayed.gate;await page.locator('[data-price-scope="history"]').click();await delayed.started;
  assert.equal(await page.locator('#price-reviews [data-open-price-review]').count(),0,'pending rows disappear before a history request completes');
  // A rapid switch back must reject the late history response, then fetch the
  // current pending scope rather than restoring the old historical row.
  await page.locator('[data-price-scope="pending"]').click();holdScope=null;release();await page.locator('#price-reviews [data-review-id="'+x.review.id+'"]').waitFor();
  assert.equal(await page.locator('#price-reviews [data-review-id="'+approved.id+'"]').count(),0);
  await page.locator('[data-price-scope="history"]').click();await page.locator('#price-reviews [data-review-id="'+approved.id+'"]').waitFor();
  delayed=hold('pending');gate=delayed.gate;await page.locator('[data-price-scope="pending"]').click();await delayed.started;
  assert.equal(await page.locator('#price-reviews [data-open-price-review]').count(),0,'history rows cannot be reopened with pending semantics while loading');
  holdScope=null;release();await page.locator('#price-reviews [data-review-id="'+x.review.id+'"]').waitFor();
  await page.locator('#price-reviews [data-open-price-review]').click();const dialog=page.locator('dialog[data-price-workspace]');await dialog.locator('[data-review-id="'+x.review.id+'"]').waitFor();
  assert.equal(items.at(-1).searchParams.has('reviewId'),false);assert.equal(await dialog.locator('.price-consent input').isChecked(),false);assert.equal(await dialog.getByRole('button',{name:'手动调整折扣',exact:true}).isEnabled(),true);await closePriceWorkspace(page);
  await page.locator('[data-price-scope="history"]').click();await page.locator('#price-reviews [data-review-id="'+approved.id+'"]').waitFor();await page.locator('#price-reviews [data-open-price-review]').click();await dialog.locator('[data-review-id="'+approved.id+'"]').waitFor();
  assert.equal(items.at(-1).searchParams.get('reviewId'),approved.id);assert.equal(await dialog.locator('.price-consent input').count(),0);assert.equal(await dialog.locator('[data-manual-sku]').count(),0);
  assert.equal(await dialog.getByRole('button',{name:'手动调整折扣',exact:true}).count(),0);assert.equal(await dialog.getByRole('button',{name:'重新核对',exact:true}).count(),0);assert.equal(await dialog.locator('[data-current-recheck]').count(),0);
  assert.deepEqual(posts,[],'opening either scope never approves or requests recovery');assert.deepEqual(errors,[]);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.equal(x.journal.priceReview(x.review.id).status,'pending');assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);
 }finally{release?.();await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
