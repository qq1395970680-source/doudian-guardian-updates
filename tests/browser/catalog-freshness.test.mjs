import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

test('live count distinguishes incomplete evidence, confirmed zero and fresh partial observations',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-freshness-')),journal=new Journal(':memory:');
 const browser=new DedicatedBrowser(join(dir,'ui'),{test:true});
 const platform={inventory:{listing:{complete:true,observedAt:Date.now(),campaigns:[]},activeComplete:false,details:new Map()},progress:{}};
 const service={running:false,busy:false,status:()=>({unknown:0,verified:0,blocked:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:'900001',name:'状态测试店铺'},port:0,runtime:join(dir,'server'),dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  await browser.open('900001');const page=await browser.page();await page.goto(app.url);
  const expectCount=async value=>{await page.waitForFunction(v=>document.querySelector('#active-count')?.textContent===v,value);assert.equal(await page.locator('#active-count').innerText(),value);};
  await expectCount('—');platform.inventory.activeComplete=true;await expectCount('0');
  platform.inventory.listing.observedAt=Date.now()-6*60000;await expectCount('—');
  const now=Date.now();platform.inventory={listing:{complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'},{id:'400002',status:'进行中'}]},activeComplete:false,
   details:new Map([['400001',{complete:true,observedAt:now,products:[{productId:'300001',name:'已核对商品',skus:[{id:'600001',name:'原规格',baseFen:10000,discount:50,saleFen:5000}]}]}]])};
  await expectCount('1');assert.match(await page.locator('#active-foot').innerText(),/仍有活动待核对/);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
