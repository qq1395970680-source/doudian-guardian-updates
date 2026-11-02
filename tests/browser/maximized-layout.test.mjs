import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {Journal} from '../../src/journal.mjs';
import {projectBuild} from '../../src/build.mjs';

for(const size of [{width:1920,height:1080,scale:1},{width:2560,height:1440,scale:1.25},{width:3840,height:2160,scale:1},{width:1280,height:900,scale:2}])
test(`maximized workspace uses ${size.width} CSS pixels at DPR ${size.scale} with centered readable content`,{timeout:90000},async()=>{
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
   const logo=document.querySelector('.brand img');return{innerWidth,devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,
    main:rect('main'),catalog:rect('.catalog'),overview:rect('.overview-status'),topbar:rect('.topbar'),logo:{naturalWidth:logo.naturalWidth,displayWidth:logo.getBoundingClientRect().width},colorScheme:getComputedStyle(document.documentElement).colorScheme};
  });
  assert.equal(dimensions.innerWidth,size.width);assert.equal(dimensions.devicePixelRatio,size.scale);assert.equal(dimensions.colorScheme,'light');
  assert.ok(dimensions.scrollWidth<=dimensions.innerWidth);
  assert.ok(Math.abs(dimensions.main.right-size.width)<=1,'workspace canvas reaches the viewport edge');
  const available=size.width-dimensions.main.x,leftGutter=dimensions.catalog.x-dimensions.main.x,rightGutter=size.width-dimensions.catalog.right;
  assert.ok(Math.abs(leftGutter-rightGutter)<=1.5,'reading area is centered after the sidebar: '+JSON.stringify(dimensions));
  assert.ok(dimensions.catalog.width>=Math.min(available-128,1600),'content uses the available canvas instead of a narrow legacy column');
  assert.ok(dimensions.catalog.width<=1800,'wide monitors retain a readable content width');
  assert.ok(Math.abs(dimensions.overview.x-dimensions.catalog.x)<=1&&Math.abs(dimensions.overview.right-dimensions.catalog.right)<=1,'status and catalog share the same reading grid');
  assert.ok(Math.abs(dimensions.topbar.x-dimensions.catalog.x)<=1&&Math.abs(dimensions.topbar.right-dimensions.catalog.right)<=1,'header uses the same centered grid');
  assert.equal(await page.locator('.hero-symbol').count(),0,'removed decorative hero space does not return on wide screens');
  assert.ok(dimensions.logo.naturalWidth>=dimensions.logo.displayWidth*size.scale,'visible brand image remains sharp at the tested DPR');
  assert.equal(await page.locator('.product').count(),16);await page.locator('#next-page').click();await page.waitForFunction(()=>document.querySelector('.product')?.getAttribute('data-product-id')==='300016');
  assert.equal(await page.locator('.product').count(),16);assert.deepEqual(errors,[]);
  const key=`maximized-layout-${size.width}-dpr${size.scale}`;
  await mkdir(resolve('artifacts'),{recursive:true});const screenshot=await page.screenshot({path:resolve('artifacts',key+'.png'),fullPage:false,animations:'disabled'});
  assert.equal(screenshot.readUInt32BE(16),size.width*size.scale,'PNG physical width matches the requested DPR');assert.equal(screenshot.readUInt32BE(20),size.height*size.scale,'PNG physical height matches the requested DPR');
  await writeFile(resolve('artifacts',key+'.json'),JSON.stringify({at:new Date().toISOString(),sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),
   localFixtureOnly:true,physicalOtherDisplay:false,viewport:size,dimensions,boundedRows:16,paginationReachable:true,canvasFillsRemainingViewport:true,centeredReadableGrid:true,pngDprVerified:true,pageErrors:errors},null,2)+'\n');
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
