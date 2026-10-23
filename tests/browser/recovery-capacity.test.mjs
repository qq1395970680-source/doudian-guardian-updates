import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {createApp} from '../../src/server.mjs';
import {capacityFixture} from '../helpers/capacity-fixture.mjs';

for(const mode of ['oversized','missing-subset'])test('current SKU execution capacity preserves complete native recovery: '+mode,{timeout:300000},async()=>{
 const products=[501,2,2].map((n,i)=>({productId:String(3800000000000000000n+BigInt(i)),name:'原生容量商品'+i,
  skus:Array.from({length:n},(_,k)=>({id:String(5800000000000000000n+BigInt(i*10000+k)),name:'规格'+k,baseFen:10000+k,discount:60}))}));
 const fixture=await fixtureServer({catalogProducts:products,detailObservedPrices:true}),dir=await mkdtemp(join(tmpdir(),'guardian-native-capacity-'));
 if(mode==='missing-subset')products[0].skus=products[0].skus.slice(0,499);
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 try{
  await service.tick();const tasks=journal.list(policy.shopId),checks=journal.productChecks(policy.shopId),verified=tasks.filter(t=>t.phase==='verified');
  const report={at:new Date().toISOString(),mode,localFixtureOnly:true,liveShopTouched:false,originalHistoricalSkus:501,currentSkus:mode==='oversized'?501:499,budget:500,lastRun:service.lastRun,
   taskProducts:tasks.map(t=>t.plans.map(p=>p.productId)),taskSkuCounts:tasks.map(t=>t.plans.reduce((n,p)=>n+p.skus.length,0)),
   verifiedProducts:verified.flatMap(t=>t.plans.map(p=>p.productId)),receiptSkuCounts:verified.map(t=>t.receipt.skuCount),checks,
   submits:fixture.state.submits,risks:fixture.state.risks};
  const artifact=resolve('artifacts/recovery-capacity-native-'+mode+'.json');await writeFile(artifact,JSON.stringify(report,null,2)+'\n');
  assert.equal(service.lastRun.ok,true);assert.ok(report.taskSkuCounts.every(n=>n<=500));
  if(mode==='oversized'){
   assert.equal(checks.find(c=>c.productId===products[0].productId)?.code,'RESTORE_SKU_BUDGET',JSON.stringify(report));
   assert.equal(tasks.length,1);assert.deepEqual(report.verifiedProducts.sort(),products.slice(1).map(p=>p.productId).sort());
   assert.deepEqual(report.taskSkuCounts,[4]);assert.deepEqual(report.receiptSkuCounts,[4]);
  }else{
   assert.equal(checks.length,0);assert.equal(tasks.length,2);assert.deepEqual(report.verifiedProducts.sort(),products.map(p=>p.productId).sort());
   assert.deepEqual([...report.receiptSkuCounts].sort((a,b)=>a-b),[4,499]);
   const plan=tasks.flatMap(t=>t.plans).find(p=>p.productId===products[0].productId);assert.equal(plan.skippedSkuIds.length,2);assert.equal(plan.skus.length,499);
  }
  const expectedSubmits=mode==='oversized'?1:2;assert.equal(fixture.state.submits,expectedSubmits);assert.equal(fixture.state.risks,expectedSubmits);
  await service.tick();assert.equal(fixture.state.submits,expectedSubmits);assert.equal(fixture.state.creates,expectedSubmits);assert.equal(fixture.state.cancelAttempts||0,0);
  assert.ok(journal.histories(policy.shopId).some(b=>b.productId===products[0].productId&&b.skus.length===501));
  await writeFile(artifact,JSON.stringify({...report,passed:true,fullHistoryPreserved:true,independentReadback:true,laterPatrolNoDuplicate:true},null,2)+'\n');
 }finally{
  service.stop();await browser.close();journal.close();await fixture.close();
  assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.ok(basename(dir).startsWith('guardian-native-capacity-'));
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

test('the app shows a program capacity cause and its retry time without calling it a platform price restriction',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-capacity-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true});
 const f=capacityFixture(journal,{sizes:[501]}),now=Date.now(),planning=new GuardianService({journal,...f});let error;
 try{planning.restorePlan(f.baselines[0],{...f.baselines[0],observedAt:now});}catch(e){error=e;}
 assert.equal(error?.code,'RESTORE_SKU_BUDGET');
 journal.putProductCheck(f.policy.shopId,f.baselines[0].productId,{code:error.code,message:error.message,restoreCapacity:error.detail.restoreCapacity,at:now,retryAt:now+900000});
 const platform={inventory:{listing:{complete:true,observedAt:now,campaigns:[]},activeComplete:true,details:new Map()},progress:{}},service={running:false,busy:false,status:()=>({unknown:0,verified:0,blocked:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:f.policy.shopId,name:'容量原因测试'},port:0,runtime:join(dir,'server'),dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  await browser.open(f.policy.shopId);const page=await browser.page();await page.goto(app.url);await page.locator('#recovery-failure-summary').waitFor({state:'visible'});
  const product=page.locator('.product').first();await product.locator('summary').first().click();await product.locator('.sku-detail').waitFor({state:'visible'});
  const text=await product.innerText();assert.match(text,/501.*500/);assert.match(text,/程序每批/);assert.match(text,/重试最早时间/);assert.doesNotMatch(text,/平台价格限制/);
  assert.equal(journal.list(f.policy.shopId).length,0);await page.screenshot({path:resolve('artifacts/recovery-capacity-ui.png'),fullPage:true});
  await writeFile(resolve('artifacts/recovery-capacity-ui.json'),JSON.stringify({at:new Date().toISOString(),passed:true,localFixtureOnly:true,reasonVisible:true,programBudgetNotPlatformPrice:true,tasks:0,historySkus:501},null,2)+'\n');
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
