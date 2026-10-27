import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {createApp} from '../../src/server.mjs';

for(const mismatch of [true,false])test(`20 product precheck through recovery: ${mismatch?'count mismatch blocks before enqueue with exact diagnostics':'complete independent readback'}`,{timeout:180000},async()=>{
 const products=Array.from({length:20},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'集合验收商品'+i,
  skus:Array.from({length:3},(_,j)=>({id:String(5000000000000000000n+BigInt(i*3+j)),name:'规格'+j,baseFen:10000+i*10+j,discount:60}))}));
 const fixture=await fixtureServer({catalogProducts:products,limited:true,detailObservedPrices:true});
 const dir=await mkdtemp(join(tmpdir(),'guardian-membership-')),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 const started=Date.now(),original=fixture.state.campaigns[0];
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:Math.floor(started/1000)*1000-100000,
  endAt:Math.floor(started/1000)*1000+7*86400000-100000,products:[],removals:products.map(p=>({...p,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}))});
 let captured;
 const failure=browser.failure.bind(browser);browser.failure=async(...args)=>{if(args[2]==='precheck'){captured=structuredClone(args[4]);const capture=args[5];if(capture)args[5]=async()=>{const extra=await capture();captured={...captured,...structuredClone(extra)};return extra;};}return failure(...args);};
 if(mismatch){const expand=platform.expand.bind(platform);platform.expand=async page=>{await expand(page);await page.locator('#count').evaluate(e=>e.textContent='已选数量 19 个');};}
 try{
  const baselines=products.map(p=>({...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',campaignId:original.id,
   rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},durationMs:7*86400000,activityLimit:1000}));
  for(const b of baselines)journal.remember(b);
  journal.lease(policy.shopId,service.owner,Date.now(),300000);
  const errors=[];await service.recoverBatch(baselines.map(baseline=>({baseline})),(member,error)=>errors.push({productId:member.baseline.productId,error}));
  if(mismatch){
   assert.equal(errors.length,20);assert.equal(journal.list(policy.shopId).length,0);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
   const d=errors[0].error.detail.precheckMembership;assert.deepEqual(d.failedConditions,['COUNT_MISMATCH']);
   assert.equal(d.actualCount,20);assert.deepEqual(d.missingProductIds,[]);assert.deepEqual(d.snapshot.counts,[19]);assert.match(d.snapshot.countDetails[0].text,/19/);
   assert.deepEqual(captured.precheckMembership,d);assert.equal(captured.visibleRowsOnly,true);
   await writeFile(resolve('artifacts/membership-count-mismatch-fixture.json'),JSON.stringify({localFixtureOnly:true,diagnostic:d,blockedProducts:20,tasks:0,submits:0},null,2));
  }else{
   assert.deepEqual(errors,[]);const tasks=journal.list(policy.shopId);assert.equal(tasks.length,1);assert.equal(tasks[0].phase,'verified',tasks[0].reason);
   assert.equal(tasks[0].receipt.productCount,20);assert.equal(tasks[0].receipt.skuCount,60);assert.equal(fixture.state.uploads,1);assert.equal(fixture.state.submits,1);
   await writeFile(resolve('artifacts/membership-20-recovery-fixture.json'),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,products:20,skus:60,precheckPages:fixture.state.prechecks,uploads:1,submits:1,independentReadback:true,elapsedMs:Date.now()-started},null,2));
  }
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('dashboard displays a pre-enqueue failure and retry time with zero tasks',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-membership-ui-')),journal=new Journal(':memory:');
 const browser=new DedicatedBrowser(join(dir,'ui'),{test:true}),now=Date.now();
 const platform={inventory:{listing:{complete:true,observedAt:now,campaigns:[]},activeComplete:true,details:new Map()},progress:{}};
 const service={running:false,busy:false,status:()=>({unknown:0,verified:0,blocked:0,tasks:[]}),stop(){}};
 const b={shopId:'900001',productId:'3000000000000000001',name:'预查失败商品',campaignId:'4000000000000000001',source:'verified-platform-history',complete:true,type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'5000000000000000001',name:'规格',baseFen:10000,discount:60}]};
 journal.remember(b);journal.putProductCheck(b.shopId,b.productId,{code:'PRECHECK_MEMBERSHIP',message:'目标20件，实际10件',at:now,retryAt:now+900000,
  precheckMembership:{targetCount:20,actualCount:10,actualUniqueCount:10,targetProductIds:[b.productId],actualProductIds:[],missingProductIds:[b.productId],snapshot:{counts:[20],pagination:{page:1}}}});
 const app=await createApp({config:{shopId:'900001',name:'状态测试店铺'},port:0,runtime:join(dir,'server'),dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 journal.event(null,'product-blocked',{shopId:b.shopId,productId:b.productId,code:'PRECHECK_MEMBERSHIP',message:'当前构建现场'});
 // Old records remain attributable only to their original metadata, never to
 // whichever version happens to export the package later.
 journal.db.prepare('INSERT INTO events(task,at,kind,body) VALUES(NULL,?,?,?)').run(now-1000,'product-blocked',JSON.stringify({shopId:b.shopId,code:'PRECHECK_MEMBERSHIP',message:'未记录版本的历史错误'}));
 try{
  await browser.open('900001');const page=await browser.page();await page.goto(app.url);
  await page.locator('#recovery-failure-summary').waitFor({state:'visible'});assert.match(await page.locator('#recovery-failure-summary').innerText(),/1 件商品恢复预查失败/);
  const product=page.locator('.product').first();assert.match(await product.innerText(),/预查失败/);await product.locator('summary').first().click();
  await product.locator('.sku-detail').waitFor({state:'visible'});
  assert.match(await product.innerText(),/尚未进入恢复任务入队和提交/);assert.match(await product.innerText(),/重试最早时间/);
  await product.getByText('查看商品集合与分页诊断',{exact:true}).click();assert.match(await product.innerText(),/缺失商品ID/);assert.equal(journal.list(b.shopId).length,0);
  await page.screenshot({path:resolve('artifacts/membership-failure-ui.png'),fullPage:true});
  await page.locator('[data-view="prices"]').click();await page.locator(`[data-recovery-issue="${b.productId}"]`).waitFor();
  assert.match(await page.locator('#recovery-issues').innerText(),/PRECHECK_MEMBERSHIP/);
  assert.match(await page.locator('#recovery-issues').innerText(),/目标20件，实际10件/);
  assert.equal(journal.priceReviews(b.shopId).length,0);assert.equal(journal.list(b.shopId).length,0);
  await page.getByRole('button',{name:'程序工具',exact:true}).click();await page.locator('[data-tool="diagnostics"]').click();
  await page.getByRole('button',{name:'导出诊断包',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#diagnostics-status')?.textContent.startsWith('已保存：'));
  assert.match(await page.locator('#diagnostics-status').innerText(),/\.zip/);assert.equal(journal.list(b.shopId).length,0);
  assert.match(await page.locator('#diagnostics-status').innerText(),/当前构建 1 条/);assert.match(await page.locator('#diagnostics-status').innerText(),/来源未记录 1 条/);
  assert.match(await page.locator('#events').innerText(),/发生版本/);assert.match(await page.locator('#events').innerText(),/未保存发生时的版本/);
  await page.screenshot({path:resolve('artifacts/diagnostics-export-ui.png'),fullPage:true});
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
