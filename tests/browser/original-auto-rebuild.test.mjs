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
import {activeOriginalRebuildGrant} from '../../src/original-rebuild-policy.mjs';

test('one in-app shop authorization restores saved prices now and again after expiry without another product confirmation',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-original-auto-')),j=new Journal(join(dir,'guardian.sqlite'));
 const product={productId:'300001',name:'自动原价重建商品',skus:[{id:'500001',name:'原规格',baseFen:6875,discount:95}]};
 const other={productId:'300002',name:'仍然有效的商品',activityLimit:1000,skus:[{id:'500002',name:'其他规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({limited:true,catalogProducts:[product,other],detailObservedPrices:true}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true});
 const c=fixture.state.campaigns[0],now=Math.floor(Date.now()/1000)*1000,durationMs=28*86400000+7000;
 Object.assign(c,{type:'限量抢购',status:'进行中',autoRenew:true,risk:false,startAt:now-1000,endAt:now+durationMs-1000,products:[other]});
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[other.productId]};
 j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:c.id,historyAt:c.startAt,type:c.type,
  durationMs,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 const platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),service=new GuardianService({journal:j,platform,policy,immediate:true});
 let app,ui;
 try{
  await service.tick();assert.equal(j.priceReviews(policy.shopId)[0]?.kind,'limited-rebuild');assert.equal(fixture.state.submits,0);
  j.putSettings(policy.shopId,{executionEnabled:true,autoStart:false});
  app=await createApp({port:0,runtime:join(dir,'app'),config:policy,dependencies:{journal:j,platform,service,browser:{close:async()=>{}}}});
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  ui=await chromium.launch({headless:true});const page=await ui.newPage({viewport:{width:1280,height:850}});await page.goto(app.url);
  await page.locator('[data-view="accounts"]').click();await page.locator('#original-rebuild-consent').check();
  await page.locator('#original-rebuild-policy').click();
  for(let n=0;n<1600&&service.status().verified!==1;n++)await new Promise(r=>setTimeout(r,50));
  await service.immediatePromise;
  assert.equal(service.status().verified,1,JSON.stringify({checks:j.productChecks(policy.shopId),events:j.events(8)}));
  const first=j.list(policy.shopId).find(t=>t.phase==='verified');assert.equal(first.lossEvidence.continuities[0].kind,'authorized-original-rebuild');
  assert.equal(first.plans[0].skus[0].saleFen,6532);assert.equal(first.receipt.durationMs,durationMs);
  assert.equal(j.priceReviews(policy.shopId).filter(r=>r.status==='approved').length,0,'shop lifecycle consent must not forge a product price approval');
  const grant=activeOriginalRebuildGrant(j,policy.shopId);assert.ok(grant);
  const created=fixture.state.campaigns.find(x=>x.id===first.receipt.campaignId);
  Object.assign(created,{status:'已结束',startAt:now-durationMs-1000,endAt:now-1000,products:[]});
  await service.tick();const verified=j.list(policy.shopId).filter(t=>t.phase==='verified');
  assert.equal(verified.length,2,JSON.stringify({checks:j.productChecks(policy.shopId),events:j.events(8)}));
  assert.equal(fixture.state.submits,2);assert.equal(activeOriginalRebuildGrant(j,policy.shopId).id,grant.id);
  assert.ok(verified.every(t=>t.plans[0].skus[0].saleFen===6532&&t.receipt.durationMs===durationMs));
  await service.tick();assert.equal(fixture.state.submits,2);assert.equal(fixture.state.cancelAttempts,undefined);
  await page.locator('[data-view="accounts"]').click();await page.screenshot({path:resolve('artifacts/beta40-original-auto-rebuild-ui.png'),animations:'disabled'});
  await writeFile(resolve('artifacts/beta40-original-auto-rebuild-fixture.json'),JSON.stringify({localFixtureOnly:true,shopConsentOnce:true,productPriceApprovalCount:0,
   recoveryCount:2,submits:2,durationMs,saleFen:6532,independentSkuReadback:true,laterPatrolNoDuplicate:true,activeOtherUntouched:true},null,2)+'\n');
 }finally{await ui?.close();service.stop();await service.immediatePromise?.catch(()=>{});await browser.close();if(app)await app.close();else j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
