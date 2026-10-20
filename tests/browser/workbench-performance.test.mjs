import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]:null;
for(const scenario of [{width:960,products:120,skus:10},{width:1440,products:1000,skus:50}]){
 test(`workbench responsiveness with ${scenario.products} products at ${scenario.width}`,{timeout:90000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'guardian-ui-performance-')),journal=new Journal(':memory:');
  const browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:scenario.width,height:960}});
  const now=Date.now(),products=Array.from({length:scenario.products},(_,i)=>({productId:String(300000+i),name:'性能验收滤芯 '+i,
   skus:Array.from({length:scenario.skus},(_,n)=>({id:String(600000+i*scenario.skus+n),name:'规格 '+n,baseFen:10000+n*100,discount:50,saleFen:5000+n*50}))}));
  const detail={complete:true,observedAt:now,products};
  const inventory={listing:{complete:true,observedAt:now,campaigns:[{id:'400001',name:'本地测试活动',status:'进行中',startAt:now-1000,endAt:now+1e7}]},activeComplete:true,details:new Map([['400001',detail]])};
  const service={running:true,busy:true,status:()=>({unknown:0,verified:0,blocked:0,tasks:[],lastRun:{ok:true,startedAt:now-2000,finishedAt:now-1000}}),stop(){this.running=false;this.busy=false;}};
  const app=await createApp({config:{shopId:'900001',name:'性能隔离测试'},port:0,runtime:join(dir,'server'),dependencies:{journal,service,browser:{close:async()=>{}},platform:{inventory,progress:{stage:'本地模拟同步'}}}});
  let report;
  try{
   await browser.open('900001');const page=await browser.page(),errors=[],writes=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
   await page.goto(app.url);await page.locator('.product').first().waitFor();
   await page.evaluate(()=>{
    const state=window.performanceAudit={frames:[],tasks:[],interactions:[],renders:[],stopped:false};let last;
    const frame=at=>{if(last!=null)state.frames.push(at-last);last=at;if(!state.stopped)requestAnimationFrame(frame);};requestAnimationFrame(frame);
    if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{for(const e of list.getEntries())state.tasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:false});
    document.addEventListener('click',event=>{if(!event.isTrusted)return;const target=event.target.closest('button,summary');if(!target)return;const start=performance.now(),label=(target.textContent||'').trim().slice(0,60);requestAnimationFrame(()=>requestAnimationFrame(()=>state.interactions.push({label,ms:performance.now()-start})));},true);
    new MutationObserver(()=>state.renders.push(performance.now())).observe(document.querySelector('#products'),{childList:true});
   });
   assert.equal(await page.locator('.product').count(),16);
   // Native interactions on an isolated app. No business action buttons are used.
   for(let i=0;i<6;i++){await page.locator('.product-summary').nth(i).click();await page.locator('.product').nth(i).locator('.sku-table').waitFor();}
   assert.equal(await page.locator('.sku-table tbody tr').count(),scenario.skus*6);
   const search=[];
   for(const id of ['300001','300002','300003']){
    const start=await page.evaluate(()=>performance.now());await page.getByLabel('搜索商品名称或 ID').fill(id);
    await page.waitForFunction(value=>document.querySelectorAll('.product').length===1&&document.querySelector('.product').dataset.productId===value,id);
    search.push(await page.evaluate(start=>performance.now()-start,start));
   }
   await page.getByLabel('搜索商品名称或 ID').fill('');await page.waitForFunction(()=>document.querySelectorAll('.product').length===16);
   for(const view of ['accounts','activity','updates','overview','activity','overview']){await page.locator(`[data-view="${view}"]`).click();await page.locator('#view-'+view).waitFor({state:'visible'});}
   const openBefore=await page.locator('.product[open]').count();assert.equal(openBefore,6);
   // Let the real 3-second status and 10-second catalog timers consume fresh data.
   // No clock, visibility or animation overrides are used.
   products[0].skus[0].discount=45;products[0].skus[0].saleFen=4500;detail.observedAt=Date.now();inventory.listing.observedAt=Date.now();
   await page.locator('[data-product-id="300000"] .sku-table tbody tr').first().getByText('¥45.00',{exact:true}).waitFor({timeout:20000});
   assert.equal(await page.locator('.product[open]').count(),openBefore);
   assert.equal(await page.locator('.product').count(),16);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   // Capture key/focus behavior across a further genuine catalog refresh.
   const summary=page.locator('[data-product-id="300000"] > summary');await summary.focus();
   await page.evaluate(()=>window.performanceAudit.focusBefore=document.activeElement===document.querySelector('[data-product-id="300000"] > summary'));
   detail.observedAt=Date.now();inventory.listing.observedAt=Date.now();products[0].skus[0].saleFen=4400;products[0].skus[0].discount=44;
   await page.locator('[data-product-id="300000"] .sku-table tbody tr').first().getByText('¥44.00',{exact:true}).waitFor({timeout:20000});
   const measured=await page.evaluate(()=>{const s=window.performanceAudit;s.stopped=true;return{...s,focusAfter:document.activeElement===document.querySelector('[data-product-id="300000"] > summary'),domNodes:document.querySelectorAll('*').length};});
   await page.getByLabel('搜索商品名称或 ID').focus();
   detail.observedAt=Date.now();inventory.listing.observedAt=Date.now();products[0].skus[0].saleFen=4300;products[0].skus[0].discount=43;
   await page.locator('[data-product-id="300000"] .sku-table tbody tr').first().getByText('¥43.00',{exact:true}).waitFor({timeout:20000});
   const searchFocusPreserved=await page.evaluate(()=>document.activeElement===document.querySelector('#search'));
   const testedAppSha256=createHash('sha256').update(await readFile(resolve('public/app.js'))).digest('hex');
   report={at:new Date().toISOString(),testedAppSha256,localFixtureOnly:true,headless:true,physicalSecondComputer:false,scenario,errors,writes,
    frameIntervals:{samples:measured.frames.length,p50:percentile(measured.frames,.5),p95:percentile(measured.frames,.95),max:Math.max(...measured.frames)},
    longTasks:measured.tasks,interactionToSecondFrame:{samples:measured.interactions.length,p95:percentile(measured.interactions.map(i=>i.ms),.95),max:Math.max(...measured.interactions.map(i=>i.ms))},
    searchCompletionMs:search,domNodes:measured.domNodes,catalogRenders:measured.renders.length,expandedPreserved:true,focusBefore:measured.focusBefore,focusAfter:measured.focusAfter,searchFocusPreserved,
    scope:'Local responsiveness evidence, not a production FPS guarantee or a second-device benchmark. Frame cadence includes host load and headless rendering; search timings include automation and the app debounce.'};
   await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`workbench-performance-${scenario.width}.json`),JSON.stringify(report,null,2)+'\n');
   assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
   // Focus is a behavior invariant; timing remains measured evidence, not a flaky CI gate.
   assert.equal(measured.focusAfter,true,'automatic catalog refresh must preserve keyboard focus on the same product');
   assert.equal(searchFocusPreserved,true,'automatic catalog refresh must not steal focus from search');
  }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});if(report)console.log(JSON.stringify(report));}
 });
}
