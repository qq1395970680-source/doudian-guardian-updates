import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {createApp} from '../../src/server.mjs';
import {fixtureServer} from './platform-fixture.mjs';
test('unproven member loss requires in-app explicit rebuild consent before native submission and exact readback',{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-rebuild-confirm-')),j=new Journal(join(dir,'guardian.sqlite'));
 const product={productId:'300001',name:'重新建活动测试商品',skus:[{id:'500001',name:'原规格',baseFen:10000,discount:50}]};
 const other={productId:'300002',name:'正常商品',activityLimit:1000,skus:[{id:'500002',name:'其他规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({limited:true,catalogProducts:[product,other]}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true});
 const c=fixture.state.campaigns[0],now=Math.floor(Date.now()/1000)*1000;Object.assign(c,{type:'限量抢购',status:'进行中',autoRenew:true,risk:false,startAt:now-1000,endAt:now+7*86400000-1000,products:[other]});
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[other.productId]};
 j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:c.id,historyAt:c.startAt,type:c.type,
  durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 const platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),service=new GuardianService({journal:j,platform,policy,immediate:true});
 let discoveries=0;const discover=platform.discover.bind(platform);platform.discover=async args=>{discoveries++;return discover(args);};
 let app,ui;
 try{
  await service.tick();const review=j.priceReviews(policy.shopId)[0];assert.equal(review?.kind,'limited-rebuild',JSON.stringify({checks:j.productChecks(policy.shopId),events:j.events(10)}));
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(j.list(policy.shopId).length,0);
  app=await createApp({port:0,runtime:join(dir,'app'),config:policy,dependencies:{journal:j,platform,service,browser:{close:async()=>{}}}});
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  ui=await chromium.launch({headless:true});const page=await ui.newPage({viewport:{width:1280,height:850}});
  await page.goto(app.url);await page.locator('[data-view="prices"]').click();const card=page.locator(`[data-review-id="${review.id}"]`);await card.waitFor();
  await card.getByText(/重新提供总限量 1000 件/).waitFor();assert.equal(await card.getByRole('checkbox').isChecked(),false);
  assert.match(await card.locator('.price-consent').innerText(),/退出原因尚未证实.*确切时长及限量额度/);
  await page.screenshot({path:resolve('artifacts/beta38-rebuild-confirmation-ui.png'),animations:'disabled'});
  const beforeConfirm=discoveries;await card.getByRole('checkbox').check();await card.getByRole('button',{name:'确认重新创建并继续守护',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.price-consent')===null);
  assert.equal(j.priceTarget(policy.shopId,product.productId).consent.rebuildConfirmed,true);assert.equal(fixture.state.submits,0);
  for(let n=0;n<1200&&service.status().verified!==1;n++)await new Promise(r=>setTimeout(r,50));
  // A verified receipt precedes the priority runner's catalogue refresh.
  // Let that same runner finish before starting a patrol or closing its browser.
  await service.immediatePromise;
  assert.equal(service.status().verified,1,JSON.stringify({checks:j.productChecks(policy.shopId),events:j.events(12)}));assert.equal(discoveries,beforeConfirm,'Confirmation restores without a new full patrol');
  const task=j.list(policy.shopId).find(t=>t.phase==='verified');assert.equal(task.lossEvidence.continuities[0].kind,'confirmed-rebuild');
  assert.equal(task.receipt.productLimits[0].activityLimit,1000);assert.equal(task.receipt.skuCount,1);
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(fixture.state.cancelAttempts,undefined);
  await writeFile(resolve('artifacts/beta38-rebuild-confirmation-native.json'),JSON.stringify({localFixtureOnly:true,unprovenLossDidNotSubmit:true,
   fullActivityAndQuantityConsentInUi:true,immediateWithoutFullPatrol:true,nativeSubmits:1,independentSkuReadback:true,laterPatrol:true,duplicateSubmits:0},null,2)+'\n');
 }finally{await ui?.close();service.stop();await service.immediatePromise?.catch(()=>{});await browser.close();if(app)await app.close();else j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
