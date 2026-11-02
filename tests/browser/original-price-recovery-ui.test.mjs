import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {activeOriginalPriceRecoveryGrant} from '../../src/original-price-recovery-policy.mjs';
import {activePriceIncreaseGrant,setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';
import {activeOriginalRebuildGrant,setOriginalRebuildPolicy} from '../../src/original-rebuild-policy.mjs';
import {seedPriceQueue} from '../helpers/large-price-queue-fixture.mjs';
import {revealControl} from '../helpers/price-workspace-ui.mjs';

test('original-only authorization stays shop scoped while explicit price decisions have one pending owner',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-original-only-ui-')),journal=new Journal(':memory:');
 const browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:960,height:1000}});
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){},latestHistories:()=>new Map()};
 const app=await createApp({config:{shopId:'900001',name:'甲店',originalRiskAllowed:true},runtime:join(dir,'server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},
  platformFactory:policy=>({probe:async()=>({shopId:policy.shopId}),discover:async()=>({baselines:[],activeComplete:true})})}});
 new AccountRegistry(journal).authorizeOriginal('900001');
 const originalGrant=setOriginalRebuildPolicy(journal,'900001',{enabled:true,acceptOriginalRebuild:true},Date.now()-1000);
 seedPriceQueue(journal,{pending:2,approved:1});setPriceIncreasePolicy(journal,'900001',{enabled:true,acceptHigherPricesAndRisk:true});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url,'X-Guardian-Token':token},body:'{}'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('[data-view="accounts"]').click();
  const consent=page.locator('#original-price-consent'),button=page.locator('#original-price-policy');
  assert.equal(await page.locator('#care-policy-status').isVisible(),true);assert.equal(await page.locator('#care-policy-consent').isChecked(),false);await revealControl(button);
  assert.equal(await button.isDisabled(),true);await consent.check();assert.equal(activeOriginalPriceRecoveryGrant(journal,'900001'),null);
  await button.click();await page.waitForFunction(()=>document.querySelector('#original-price-policy')?.textContent==='停止原价自动恢复');
  assert.ok(activeOriginalPriceRecoveryGrant(journal,'900001'));assert.equal(activePriceIncreaseGrant(journal,'900001'),null);
  assert.equal(activeOriginalRebuildGrant(journal,'900001').key,originalGrant.key,'mode activation must preserve the original grant used by existing unknown submissions');
  assert.equal(activeOriginalPriceRecoveryGrant(journal,'900002'),null);assert.equal(await page.locator('#price-increase-policy').isDisabled(),true);
  const prices=await(await fetch(app.url+'/api/price-reviews?direction=increase')).json();assert.equal(prices.pending,0);assert.equal(prices.total,0);
  const all=await(await fetch(app.url+'/api/price-reviews')).json();assert.equal(all.total,1);assert.equal(all.reviews[0].status,'approved');
  const pending=await(await fetch(app.url+'/api/price-reviews?scope=pending&direction=all')).json();assert.equal(pending.pending,2);assert.equal(pending.total,2);assert.ok(pending.reviews.every(r=>r.status==='pending'));
  const candidate=pending.reviews[0],legacy=await fetch(app.url+'/api/price-reviews/decide',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url,'X-Guardian-Token':token},body:JSON.stringify({shopId:'900001',reviewId:candidate.id,key:candidate.key,decision:'approve',acceptPriceAndRisk:true,confirmedSkuIds:candidate.rows.map(r=>r.id)})});
  assert.equal(legacy.status,400);assert.equal((await legacy.json()).code,'ORIGINAL_PRICE_BLOCKED');assert.equal(journal.priceTarget('900001',candidate.productId),null,'legacy API cannot bypass explicit per-product exception');
  assert.equal(journal.priceReviewCounts('900001').pending,2);assert.equal(journal.priceReviews('900001').length,3);
  await page.locator('[data-view="prices"]').click();await page.locator('[data-price-scope="pending"]').click();await page.locator('[data-price-direction="all"]').click();await page.waitForFunction(()=>document.querySelectorAll('#price-reviews [data-price-product]').length===2);assert.equal(await page.locator('#price-count').innerText(),'2');
  await page.locator('[data-view="blockers"]').click();assert.equal(await page.locator('[data-blocker-filter="all"]').getAttribute('class').then(s=>s.includes('selected')),true);
  assert.equal(await page.locator('#blocker-records [data-open-price-review]').count(),0,'actionable prices are not duplicated as blocked work');
  await page.locator('[data-view="accounts"]').click();await revealControl(button);await button.click();await page.waitForFunction(()=>document.querySelector('#original-price-policy')?.textContent==='开启原价自动恢复');
  assert.equal(activeOriginalPriceRecoveryGrant(journal,'900001'),null);assert.equal((await(await fetch(app.url+'/api/price-reviews')).json()).pending,2);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts','original-price-recovery-960.png'),fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
