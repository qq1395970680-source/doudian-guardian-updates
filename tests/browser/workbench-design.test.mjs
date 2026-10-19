import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

for(const width of [1440,960])test('light desktop UI, bounded catalog, lazy SKU view and responsive interactions '+width,{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-design-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1000}});
 const now=Date.now(),products=Array.from({length:37},(_,i)=>({productId:String(300000+i),name:['家用净水器复合滤芯','五级超滤净水器滤芯套装','反渗透净水器长效滤芯'][i%3]+' · '+(i+1),skus:Array.from({length:10},(_,n)=>({id:String(600000+i*10+n),name:'滤芯规格 '+(n+1),baseFen:8000+n*2000,discount:50,saleFen:4000+n*1000}))}));
 const inventory={listing:{complete:true,observedAt:now,campaigns:[{id:'400001',name:'全店折扣',status:'进行中',startAt:now-1000,endAt:now+1e7}]},activeComplete:true,details:new Map([['400001',{complete:true,observedAt:now,products}]])};
 const service={running:true,busy:false,status:()=>({unknown:0,verified:9,blocked:0,tasks:[],nextAt:now+60000,lastRun:{finishedAt:now}}),stop(){this.running=false;}};
 const app=await createApp({config:{shopId:'900001',name:'演示店铺',originalRiskAllowed:true},port:0,runtime:join(dir,'server'),dependencies:{journal,service,browser:{close:async()=>{}},platform:{inventory,progress:{stage:'当前活动核对完成'}}}});
 try{await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);await page.locator('.product').first().waitFor();
  assert.equal(await page.locator('.product').count(),16);assert.equal(await page.locator('.sku-table').count(),0);assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');
  assert.doesNotMatch(await page.locator('body').innerText(),/旧版|旧扩展|接管|交接/);
  await page.locator('.product-summary').first().click();await page.locator('.sku-table').waitFor();assert.equal(await page.locator('.sku-table tbody tr').count(),10);
  await page.evaluate(()=>window.testProductNode=document.querySelector('.product'));
  // Repeated status polls must not rebuild the same expanded product DOM.
  await page.waitForTimeout(3300);assert.equal(await page.evaluate(()=>window.testProductNode===document.querySelector('.product')),true);
  await page.getByLabel('搜索商品名称或 ID').fill('300036');await page.waitForFunction(()=>document.querySelectorAll('.product').length===1);assert.equal(await page.locator('.product').getAttribute('data-product-id'),'300036');
  await page.getByLabel('搜索商品名称或 ID').fill('');await page.waitForFunction(()=>document.querySelectorAll('.product').length===16);
  for(const name of ['accounts','activity','updates','overview']){await page.locator(`[data-view="${name}"]`).click();await page.locator('#view-'+name).waitFor({state:'visible'});}
  await page.route('**/api/updates/check',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({state:'available',release:{version:'2.0.0-beta.3',notes:'本地模拟更新测试'}})}));
  await page.locator('[data-view="updates"]').click();await page.locator('#check-updates').click();await page.getByText('发现新版本 2.0.0-beta.3',{exact:true}).waitFor();assert.equal(await page.locator('#install-update').isEnabled(),true);
  await page.locator('[data-view="overview"]').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`workbench-light-${width}.png`),fullPage:false});
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.view.active').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.deepEqual(errors,[]);await writeFile(resolve('artifacts',`workbench-design-${width}.json`),JSON.stringify({width,light:true,errors,boundedRows:16,lazySkus:true,unchangedPollPreservesDom:true,noHorizontalOverflow:true,reducedMotion:true}));
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
