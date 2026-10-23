import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {Journal} from '../../src/journal.mjs';
import {projectBuild} from '../../src/build.mjs';

for(const size of [{width:1920,height:1080,scale:1},{width:2560,height:1440,scale:1.25},{width:3840,height:2160,scale:1},{width:1280,height:900,scale:2}])
test(`maximized layout fills ${size.width} CSS pixels at DPR ${size.scale} without an unused right region`,{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-maximized-')),journal=new Journal(':memory:'),now=Date.now();
 const browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:size.width,height:size.height},deviceScaleFactor:size.scale});
 const products=Array.from({length:37},(_,i)=>({productId:String(300000+i),name:'宽屏回归商品 '+i,
  skus:[{id:String(500000+i),name:'标准规格',baseFen:10000,discount:60,saleFen:6000}]}));
 const platform={progress:{stage:'本地布局验收'},inventory:{listing:{complete:true,observedAt:now,campaigns:[{id:'400001',name:'布局夹具活动',status:'进行中',startAt:now-10000,endAt:now+86400000}]},
  activeComplete:true,details:new Map([['400001',{complete:true,observedAt:now,products}]])}};
 const service={running:true,busy:false,status:()=>({unknown:0,verified:0,blocked:0,tasks:[],nextAt:now+60000,lastSuccessfulRun:{ok:true,startedAt:now-2000,finishedAt:now-1000}}),stop(){this.running=false;}};
 const app=await createApp({config:{shopId:'900001',name:'宽屏隔离验收'},runtime:join(dir,'server'),port:0,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('.product').first().waitFor();await page.emulateMedia({reducedMotion:'reduce'});
  const dimensions=await page.evaluate(()=>{
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,right:r.right,width:r.width};};
   const icon=document.querySelector('.hero-symbol img');return{innerWidth,devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,
    catalog:rect('.catalog'),hero:rect('.hero'),icon:{naturalWidth:icon.naturalWidth,displayWidth:icon.getBoundingClientRect().width},colorScheme:getComputedStyle(document.documentElement).colorScheme};
  });
  assert.equal(dimensions.innerWidth,size.width);assert.equal(dimensions.devicePixelRatio,size.scale);assert.equal(dimensions.colorScheme,'light');
  assert.ok(dimensions.scrollWidth<=dimensions.innerWidth);assert.ok(dimensions.catalog.right>=size.width-64,JSON.stringify(dimensions));assert.ok(dimensions.hero.right>=size.width-64);
  assert.ok(dimensions.catalog.width>size.width*.65);assert.ok(dimensions.icon.naturalWidth>=dimensions.icon.displayWidth*size.scale,'high-DPI hero icon must have enough source pixels');
  assert.equal(await page.locator('.product').count(),16);await page.locator('#next-page').click();await page.waitForFunction(()=>document.querySelector('.product')?.getAttribute('data-product-id')==='300016');
  assert.equal(await page.locator('.product').count(),16);assert.deepEqual(errors,[]);
  const key=`maximized-layout-${size.width}-dpr${size.scale}`;
  await page.screenshot({path:resolve('artifacts',key+'.png'),fullPage:false,animations:'disabled'});
  await writeFile(resolve('artifacts',key+'.json'),JSON.stringify({at:new Date().toISOString(),sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),
   localFixtureOnly:true,physicalOtherDisplay:false,viewport:size,dimensions,boundedRows:16,paginationReachable:true,pageErrors:errors},null,2)+'\n');
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
