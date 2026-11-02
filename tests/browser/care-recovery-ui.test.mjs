import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {blockerFixture} from '../helpers/blocker-prices-fixture.mjs';
import {activeCareRecoveryGrant} from '../../src/care-recovery-policy.mjs';
import {activeOriginalPriceRecoveryGrant} from '../../src/original-price-recovery-policy.mjs';

for(const width of [1440,960])test('care mode is an explicit shop choice and never implicitly accepts a lower price '+width,{timeout:45000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-care-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1000}});
 try{
  await browser.open(x.review.shopId);const page=await browser.page(),errors=[],posts=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
  await page.goto(x.app.url);await page.locator('[data-view="accounts"]').click();const button=page.locator('#care-policy-save'),consent=page.locator('#care-policy-consent');await page.waitForFunction(()=>document.querySelector('#care-policy-status')?.textContent==='未开启');
  assert.equal(await consent.isChecked(),false);assert.equal(await button.isDisabled(),true);assert.equal(activeCareRecoveryGrant(x.journal,x.review.shopId),null);assert.deepEqual(posts,[]);
  await consent.check();assert.equal(await button.isDisabled(),false);assert.equal(activeCareRecoveryGrant(x.journal,x.review.shopId),null,'checking the policy alone never authorizes a target');
  await button.click();await page.waitForFunction(()=>document.querySelector('#care-policy-status')?.textContent==='已开启');
  assert.ok(activeCareRecoveryGrant(x.journal,x.review.shopId));assert.equal(activeCareRecoveryGrant(x.journal,'900002'),null);assert.equal(activeOriginalPriceRecoveryGrant(x.journal,x.review.shopId).key,x.grant.key);
  assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null,'the existing price reduction still needs separate exact consent');assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);
  assert.deepEqual(posts,['/api/care-recovery-policy']);assert.equal(await page.locator('#care-policy-consent-wrap').isVisible(),false);assert.match(await button.innerText(),/停用/);
  await mkdir(resolve('artifacts','care-ui'),{recursive:true});await page.screenshot({path:resolve('artifacts','care-ui',`enabled-${width}.png`),fullPage:false});
  await button.click();await page.waitForFunction(()=>document.querySelector('#care-policy-status')?.textContent==='未开启');assert.equal(activeCareRecoveryGrant(x.journal,x.review.shopId),null);assert.equal(await consent.isChecked(),false);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.deepEqual(errors,[]);
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
