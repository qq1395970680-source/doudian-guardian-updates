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
import {openPriceWorkspace,closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';
import {blockerFixture} from '../helpers/blocker-prices-fixture.mjs';
import {priceOptions} from '../../src/price-options.mjs';

for(const width of [1440,960])test('one blocked product retains retry progress and clears after a persisted independent check '+width,{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-recheck-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:960}});
 const f=ratioFixture(journal,{now:Date.now()}),review=journal.recordRemovalPriceReview(f.plan,f.loss);let failure=true,reads=0;
 const platform={progress:{stage:'test'},probe:async()=>({shopId:f.policy.shopId,name:'重新核对测试'}),
  precheck:async()=>{reads++;if(failure)throw Object.assign(new Error('批量预查商品集合不一致：目标20件，实际19件'),{code:'PRECHECK_MEMBERSHIP'});return{...structuredClone(f.current),observedAt:Date.now()};},
  precheckBatch:async()=>{throw Error('Only one requested product');},
  lossBatch:async()=>[{productId:f.baseline.productId,loss:{complete:true,active:true,observedAt:Date.now(),campaignId:'400009'}}]};
 const service=new GuardianService({journal,platform,policy:f.policy,immediate:true});
 const app=await createApp({config:f.policy,runtime:join(dir,'server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform}});
 try{
  await browser.open(f.policy.shopId);const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.locator('[data-view="accounts"]').click();await page.locator('#finish-login').click();await page.waitForFunction(()=>!document.querySelector('#finish-login').disabled);
  const dialog=await openPriceWorkspace(page,review.productId);await dialog.getByRole('button',{name:'重新核对',exact:true}).click();await closePriceWorkspace(page);
  await page.locator('[data-view="blockers"]').click();const row=page.locator(`[data-recovery-blocker="${f.baseline.productId}"]`);await row.waitFor();await row.getByText('读取或校验受阻',{exact:true}).waitFor();
  await row.locator('.blocker-details > summary').click();assert.match(await row.innerText(),/PRECHECK_MEMBERSHIP/);assert.match(await row.innerText(),/目标20件，实际19件/);assert.match(await row.innerText(),/恢复请求：blocked/);
  assert.equal(await page.locator('#recovery-issues-panel').isVisible(),false);assert.equal(await page.locator('[data-price-recheck]').count(),0,'same problem has one visible product owner');
  assert.equal(journal.priceReview(review.id).status,'superseded');assert.equal(journal.priceTarget(f.policy.shopId,f.baseline.productId),null);assert.equal(journal.list(f.policy.shopId).length,0);
  await page.waitForFunction(()=>document.querySelector('#price-count').textContent==='0');await page.evaluate(()=>window.recheckNode=document.querySelector('[data-recovery-blocker]'));
  await page.waitForResponse(r=>r.url().includes('/api/recovery-blockers?'));assert.equal(await page.evaluate(()=>window.recheckNode===document.querySelector('[data-recovery-blocker]')),true);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`beta59-recheck-blocked-${width}.png`),fullPage:false});
  failure=false;await row.getByRole('button',{name:'现在重新核验',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-recovery-blocker]'),null,{timeout:15000});assert.equal(reads,2,'retry runs immediately without waiting for a patrol');
  assert.equal(journal.list(f.policy.shopId).length,0,'an independently observed existing activity cannot cause a duplicate submission');
  const conclusion=journal.settings('priority-recovery:'+f.policy.shopId).recent.find(r=>r.productId===f.baseline.productId);assert.equal(conclusion.state,'complete');assert.equal(conclusion.currentActivity.campaignId,'400009');assert.match(conclusion.reason,/不计作新的恢复/);
  await page.reload();await page.locator('[data-view="blockers"]').click();await page.getByText('当前没有需要补充核验的商品。需要确认的价格统一在价格确认查看。',{exact:true}).waitFor();assert.equal(await row.count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{service.stop();await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('a declined current proposal can be explicitly reconsidered while archived browsing remains read-only',{timeout:45000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-declined-workspace-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:1440,height:960}});
 x.service.decidePriceReview({reviewId:x.review.id,key:x.review.key,decision:'decline'});
 try{await browser.open(x.review.shopId);const page=await browser.page(),posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.postDataJSON());});await page.goto(x.app.url);
  const history=await openPriceWorkspace(page,x.review.productId,{scope:'history'});assert.equal(await history.locator('.price-consent input').count(),0);assert.equal(await history.getByRole('button',{name:'重新核对',exact:true}).count(),0,'opening an archived record cannot change it');await closePriceWorkspace(page);
  await page.locator('[data-view="blockers"]').click();await page.locator(`[data-recovery-blocker="${x.review.productId}"] [data-open-price-review]`).click();const current=page.locator('dialog[data-price-workspace]');await current.locator('[data-review-id]').waitFor();
  assert.equal(await current.locator('.price-consent input').count(),0);assert.equal(await current.locator('[data-manual-sku]').count(),0);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/price-reviews/decide'));await current.getByRole('button',{name:'重新核对',exact:true}).click();assert.equal((await response).status(),200);
  assert.equal(x.journal.priceReview(x.review.id).status,'superseded');assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);assert.equal(posts.length,1);assert.equal(posts[0].decision,'recalculate');
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});

test('rechecking expired declined metadata never recalculates the displayed old approved target',{timeout:45000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-approved-fallback-ui-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:1440,height:960}});
 const option=priceOptions(x.review).find(o=>o.id==='original'),approved=x.service.decidePriceReview({reviewId:x.review.id,key:x.review.key,decision:'approve',acceptPriceAndRisk:true,confirmedSkuIds:x.review.rows.map(r=>r.id),optionId:option.id,optionKey:option.key});
 const {id,key,status,approvedAt,consent,selectedOption,originalProposalRows,...base}=approved,now=Date.now();
 const candidate=x.journal.savePriceReview({...base,key:'expired-current-review-key',previousApprovalId:approved.id,createdAt:now-1000,expiresAt:now-1,rows:approved.rows.map((r,i)=>({...r,previousDiscount:r.discount,previousFen:r.saleFen,discount:i===0?47:r.discount,saleFen:i===0?6533:r.saleFen}))},now-900);
 x.journal.decidePriceReview(x.review.shopId,candidate.id,candidate.key,'decline',{},now-800);
 try{await browser.open(x.review.shopId);const page=await browser.page(),posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.postDataJSON());});await page.goto(x.app.url);
  const history=await openPriceWorkspace(page,x.review.productId,{scope:'history'});assert.equal(await history.locator('[data-current-recheck]').count(),0);assert.equal(await history.getByRole('button',{name:'重新核对',exact:true}).count(),0);await closePriceWorkspace(page);
  await page.locator('[data-view="blockers"]').click();await page.locator(`[data-recovery-blocker="${x.review.productId}"] [data-open-price-review]`).click();const drawer=page.locator('dialog[data-price-workspace]');await drawer.locator('[data-current-recheck]').waitFor();
  assert.match(await drawer.locator('table[data-role="price-target-table"]').innerText(),/66\.72/);assert.equal(await drawer.locator('.price-consent input').count(),0);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/price-reviews/decide'));await drawer.locator('[data-current-recheck]').getByRole('button',{name:'重新核对当前方案',exact:true}).click();assert.equal((await response).status(),200);
  assert.equal(posts.length,1);assert.equal(posts[0].reviewId,candidate.id);assert.equal(posts[0].key,candidate.key);assert.equal(posts[0].decision,'recalculate');assert.notEqual(posts[0].reviewId,approved.id);
  assert.equal(x.journal.priceReview(candidate.id).status,'superseded');assert.equal(x.journal.priceReview(approved.id).status,'approved');assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId).id,approved.id);assert.deepEqual(x.journal.priceReview(approved.id).rows,approved.rows);assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);
 }finally{await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
