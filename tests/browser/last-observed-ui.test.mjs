import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {catalogObservation} from '../../src/catalog.mjs';

test('a refreshing catalog keeps labeled previous prices and success time without claiming current validity',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-last-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:1100,height:900}}),now=Date.now();
 const campaign={id:'400001',status:'进行中',name:'活动',startAt:now-3600000,endAt:now+3600000};
 const platform={inventory:{listing:{complete:true,observedAt:now,campaigns:[campaign]},activeComplete:true,details:new Map([['400001',{complete:true,observedAt:now-30000,products:[{productId:'300001',name:'演示滤芯',skus:[{id:'600001',name:'标准规格',baseFen:10000,discount:50,saleFen:5000}]}]}]])},progress:{}};
 journal.putSettings('catalog-view:900001',catalogObservation('900001',platform.inventory));
 const service={running:false,busy:false,status:()=>({unknown:0,verified:0,blocked:0,tasks:[],lastSuccessfulRun:{startedAt:now-60000,finishedAt:now-30000,ok:true}}),stop(){}};
 const app=await createApp({config:{shopId:'900001',name:'显示验收店铺'},port:0,runtime:join(dir,'server'),dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.waitForFunction(()=>document.querySelector('#active-count')?.textContent==='1');
  platform.inventory={...platform.inventory,activeComplete:false,details:new Map()};
  journal.putSettings('catalog-view:900001',catalogObservation('900001',platform.inventory,journal.settings('catalog-view:900001')));
  await page.locator('.last-price-note').waitFor();
  const product=page.locator('[data-product-id="300001"]');assert.match(await product.innerText(),/¥50\.00/);assert.match(await product.innerText(),/上次读取/);assert.match(await product.innerText(),/待更新/);
  assert.equal(await page.locator('#active-count').innerText(),'—');assert.match(await page.locator('#schedule').innerText(),/上次成功/);assert.doesNotMatch(await page.locator('#schedule').innerText(),/尚无记录/);
  await product.locator('summary').first().click();await page.getByText('以下为上次读取的价格，正在重新核对，不能代表当前仍然生效。',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/last-observed-ui.png'),fullPage:true});
  platform.inventory={listing:{complete:true,observedAt:Date.now(),campaigns:[]},activeComplete:true,details:new Map()};
  journal.putSettings('catalog-view:900001',catalogObservation('900001',platform.inventory,journal.settings('catalog-view:900001')));
  await page.waitForFunction(()=>document.querySelector('#active-count')?.textContent==='0');assert.equal(await page.locator('.last-price-note').count(),0);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
