import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {ratioFixture} from '../helpers/ratio-review-fixture.mjs';

for(const width of [1440,960])test('recalculate stays visible through failure, immediate retry and a persisted conclusion '+width,{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-recheck-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:960}});
 const f=ratioFixture(journal,{now:Date.now()}),review=journal.recordRemovalPriceReview(f.plan,f.loss);
 let failure=true,reads=0;
 const platform={progress:{stage:'test'},probe:async()=>({shopId:f.policy.shopId,name:'重新核对测试'}),
  precheck:async()=>{reads++;if(failure)throw Object.assign(new Error('批量预查商品集合不一致：目标20件，实际19件'),{code:'PRECHECK_MEMBERSHIP'});return{...structuredClone(f.current),observedAt:Date.now()};},
  precheckBatch:async()=>{throw Error('Only one requested product');},
  lossBatch:async()=>[{productId:f.baseline.productId,loss:{complete:true,active:true,observedAt:Date.now(),campaignId:'400009'}}]};
 const service=new GuardianService({journal,platform,policy:f.policy,immediate:true});
 const app=await createApp({config:f.policy,runtime:join(dir,'server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform}});
 try{
  await browser.open(f.policy.shopId);const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('[data-view="accounts"]').click();await page.locator('#finish-login').click();
  await page.waitForFunction(()=>!document.querySelector('#finish-login').disabled);
  await page.locator('[data-view="prices"]').click();const card=page.locator(`[data-review-id="${review.id}"]`);await card.waitFor();
  if(!await card.evaluate(e=>e.open))await card.locator('summary').click();
  await card.getByRole('button',{name:'重新核对',exact:true}).click();
  const row=page.locator(`[data-price-recheck="${f.baseline.productId}"]`);await row.waitFor();await row.getByText('核对受阻',{exact:true}).waitFor();
  assert.match(await row.innerText(),/PRECHECK_MEMBERSHIP/);assert.match(await row.innerText(),/目标20件，实际19件/);
  assert.equal(journal.priceReview(review.id).status,'superseded');assert.equal(journal.priceTarget(f.policy.shopId,f.baseline.productId),null);
  assert.equal(await page.locator('.price-review').count(),0);assert.equal(journal.list(f.policy.shopId).length,0);
  await page.waitForFunction(()=>document.querySelector('#price-count').textContent==='1');
  await page.evaluate(()=>window.recheckNode=document.querySelector('[data-price-recheck]'));
  await page.waitForResponse(r=>r.url().includes('/api/price-reviews?'));
  assert.equal(await page.evaluate(()=>window.recheckNode===document.querySelector('[data-price-recheck]')),true);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`beta42-recheck-blocked-${width}.png`),fullPage:false});
  failure=false;await row.getByRole('button',{name:'重新核验恢复',exact:true}).click();
  await row.getByText('核验已结束',{exact:true}).waitFor();assert.equal(reads,2,'Retry must run immediately, without waiting for a patrol');
  assert.equal(journal.list(f.policy.shopId).length,0,'A positive activity must not cause a duplicate submission');
  assert.doesNotMatch(await row.innerText(),/该次恢复已回读/);
  await page.reload();await page.locator('[data-view="prices"]').click();await page.locator('[data-price-recheck]').getByText('核验已结束',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{service.stop();await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
