import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
test('workbench exposes actual backend version, slow business progress, cleanup quarantine and login pause',{timeout:90000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-read-health-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(runtime,'ui'),{test:true}),now=Date.now();
 let health={quarantined:false,active:[{kind:'detail',campaignId:'400001',startedAt:now-180000,deadline:now+120000,lastStep:'page.evaluate'}]};
 const service={running:true,busy:true,status:()=>({version:'2.0.0-beta.30',readHealth:health,unknown:0,verified:0,blocked:0,tasks:[],patrolStartedAt:now-240000,lastRun:service.lastRun}),stop(){this.running=false;this.busy=false;}};
 const app=await createApp({config:{shopId:'900001',name:'健康隔离测试'},port:0,runtime:join(runtime,'server'),dependencies:{journal,service,
  platform:{progress:{stage:'核对当前活动',at:now-180000}},browser:{close:async()=>{}}}});
 try{
  await browser.open('900001');const page=await browser.page();
  await page.addInitScript(()=>{window.guardianDesktop={version:'2.0.0-beta.33',onUpdate:()=>{},updateStatus:async()=>({state:'idle'})};});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='读取较慢');
  assert.equal(await page.locator('#version').innerText(),'后台 v2.0.0-beta.30');assert.match(await page.locator('#update-version').innerText(),/后台尚未切换/);
  assert.match(await page.locator('#schedule').innerText(),/业务进度已等待/);assert.match(await page.locator('#progress').innerText(),/400001/);
  health={quarantined:true,active:[]};await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='清理待核实');
  assert.match(await page.locator('#progress').innerText(),/修复只读后台/);
  health={quarantined:false,active:[]};service.running=false;service.busy=false;service.lastRun={ok:false,code:'LOGIN_REQUIRED'};
  await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='需要登录');assert.match(await page.locator('#progress').innerText(),/重新登录/);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
