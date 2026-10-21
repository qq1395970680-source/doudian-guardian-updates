import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {createApp} from '../../src/server.mjs';
import {GuardianService} from '../../src/service.mjs';
import {planOriginalRestore,fingerprint} from '../../src/policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
import {installDateTimeFixture} from './date-time-fixture.mjs';
import {installArcoDateFixture} from './arco-date-fixture.mjs';

for(const picker of ['arco'])for(const type of ['限量抢购','限时抢购'])test(`old approved price requires UI reconfirmation before blocked recovery: ${type} ${picker}`,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-duration-retry-')),file=join(dir,'tasks.sqlite');
 const catalogProducts=[{productId:'3849118543765439254',name:'取整测试',skus:[{id:'3386359933583653',name:'规格甲',baseFen:6875,discount:95}]}];
 const fixture=await fixtureServer({catalogProducts,detailObservedPrices:true,limited:type==='限量抢购'}),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let app,uiBrowser;
 let browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(file),service;
 let failOld=true,clock=Date.now()-16*60000,lossReads=0,prechecks=0;
 const baseline={...structuredClone(catalogProducts[0]),source:'verified-platform-history',complete:true,shopId:policy.shopId,type,durationMs:2419207000,activityLimit:1000,campaignId:'4000000000000000001',
  rules:{noLimit:type!=='限量抢购',noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(type==='限量抢购'?{autoRenew:true}:{})}};
 const create=()=>{
  const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});
  // Discovery/loss are controlled fixture evidence. SKU precheck, draft,
  // submit, risk prompt and independent receipt all use the browser adapter.
  const facade={progress:{stage:'local fixture'},probe:async()=>({shopId:policy.shopId,name:'隔离测试店'}),discover:async()=>({baselines:[baseline],activeComplete:true}),
   loss:async()=>{lossReads++;return {complete:true,active:fixture.state.submits>0,observedAt:clock,lossKey:'fixture-explicit-removal'};},
   precheck:async b=>{prechecks++;return {...await platform.precheck(b),observedAt:clock};},
   prepare:async t=>{return platform.prepare(t);},
   submit:platform.submit.bind(platform),readback:platform.readback.bind(platform),release:platform.release.bind(platform)};
  platform.setDates=async(page,plan)=>{
   await page.evaluate(picker==='arco'?installArcoDateFixture:installDateTimeFixture,{start:Math.floor(Date.now()/1000)*1000,duration:plan.durationMs});
   // Fixture's onchange handler owns its server-facing form state.
   if(picker==='legacy')await page.evaluate(()=>{window.commitExactDates=()=>document.querySelector('input[placeholder="开始日期"]').onchange();document.querySelector('.ecom-mcenter-picker-dropdown button').addEventListener('click',window.commitExactDates);});
   await DoudianPlatform.prototype.setDates.call(platform,page,plan);
  };
  const instance=new GuardianService({journal,platform:facade,policy,now:()=>failOld?clock:Date.now()});
  platform.assertWrite=facade.assertWrite;return instance;
 };
 try{
  service=create();journal.remember(baseline);
  const current=await service.platform.precheck(baseline),oldPlan=planOriginalRestore(baseline,current,policy,clock);
  oldPlan.skus[0].saleFen=6531;const {fingerprint:oldHash,...material}=oldPlan;oldPlan.fingerprint=fingerprint(material);
  const oldTask=journal.enqueue(policy.shopId,[oldPlan],{complete:true,observedAt:clock,lossKey:'old-rounding'},clock);
  // Reproduce the pre-submit rejection with the actual browser adapter.
  clock=Date.now();journal.lease(policy.shopId,service.owner,clock,180000);await service.execute(oldTask);journal.release(policy.shopId,service.owner);const blocked=journal.get(oldTask.id);
  assert.equal(blocked.phase,'blocked');assert.match(blocked.reason,/DRAFT_PRICE/);assert.equal(blocked.submitAttempts,0);assert.equal(fixture.state.submits,0);
  const oldReview={id:'old-approved',key:'old-key',status:'approved',shopId:policy.shopId,productId:baseline.productId,name:baseline.name,historicalFingerprint:fingerprint(baseline),type:baseline.type,rules:baseline.rules,createdAt:clock-60000,expiresAt:clock-1,approvedAt:clock-30000,consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true},rows:[{id:baseline.skus[0].id,name:'规格甲',baseFen:6875,historicalDiscount:95,previousDiscount:95,previousFen:6531,discount:95,saleFen:6531,evidence:[],bounds:{}}]};
  journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(oldReview.id,oldReview.shopId,oldReview.productId,oldReview.status,JSON.stringify(oldReview),clock);
  journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(oldReview.shopId,oldReview.productId,oldReview.id);
  const previousReads=prechecks;service.stop();await browser.close();journal.close();
  journal=new Journal(file);assert.equal(journal.get(blocked.id).phase,'blocked');
  browser=new DedicatedBrowser(dir,{test:true});failOld=false;clock=Date.now();service=create();
  await service.tick();const review=journal.priceReviews(policy.shopId).find(r=>r.status==='pending');
  assert.ok(review,JSON.stringify(journal.events(8)));assert.equal(fixture.state.submits,0);assert.equal(review.rows[0].saleFen,6532);
  await service.tick();assert.equal(fixture.state.submits,0);assert.equal(journal.priceTarget(policy.shopId,baseline.productId).id,oldReview.id);
  app=await createApp({config:policy,runtime:join(dir,'ui-server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform:service.platform}});
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url},body:'{}'});
  for(let i=0;i<50&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(app.snapshot().connection?.shopId,policy.shopId);
  uiBrowser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:1280,height:960}});await uiBrowser.open(policy.shopId);const ui=await uiBrowser.page();
  await ui.goto(app.url);await ui.locator('[data-view="prices"]').click();const card=ui.locator('[data-review-id="'+review.id+'"]');await card.waitFor();
  assert.match(await card.innerText(),/¥65.31/);assert.match(await card.innerText(),/¥65.32/);assert.match(await card.innerText(),/28 天 0 时 0 分 7 秒/);
  const button=card.getByRole('button',{name:'确认表内价格并继续守护',exact:true});assert.equal(await button.isDisabled(),true);assert.equal(await card.getByRole('checkbox').isChecked(),false);
  await ui.screenshot({path:resolve('artifacts','beta30-reconfirmation-'+(type==='限量抢购'?'limited':'timed')+'.png'),animations:'disabled',fullPage:true});
  await card.getByRole('checkbox').check();const response=ui.waitForResponse(r=>r.url().endsWith('/api/price-reviews/decide'));await button.click();assert.equal((await response).status(),200);
  assert.equal(journal.priceTarget(policy.shopId,baseline.productId).id,review.id);assert.deepEqual(journal.priceReview(oldReview.id),oldReview);
  await service.tick();const actual=journal.list(policy.shopId).find(t=>t.id!==blocked.id);
  assert.equal(journal.get(blocked.id).plans[0].skus[0].saleFen,6531);assert.equal(journal.get(blocked.id).submitAttempts,0);
  assert.equal(actual.phase,'verified',JSON.stringify({actual,run:service.lastRun}));assert.equal(journal.list(policy.shopId).length,2);
  assert.equal(actual.receipt.salePriceEvidence,'observed');assert.equal(actual.plans[0].skus[0].saleFen,6532);assert.equal(actual.draftProof.observation.rows[0].saleFen,6532);
  assert.ok(prechecks>previousReads);assert.ok(lossReads>=2);assert.equal(actual.submitAttempts,1);assert.equal(actual.receipt.durationMs,2419207000);
  const campaign=fixture.state.campaigns.at(-1);assert.equal(campaign.endAt-campaign.startAt,2419207000);
  assert.equal(actual.receipt.startAt,actual.draftProof.observation.startAt);assert.equal(actual.receipt.endAt,actual.draftProof.observation.endAt);
  assert.deepEqual(campaign.products[0].skus,catalogProducts[0].skus);
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);
 }finally{service?.stop();await uiBrowser?.close();await browser.close();if(app)await app.close();else journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
