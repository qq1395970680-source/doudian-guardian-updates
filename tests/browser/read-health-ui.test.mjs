import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
test('workbench exposes actual backend version, slow business progress, cleanup quarantine and login pause',{timeout:90000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-read-health-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(runtime,'ui'),{test:true}),now=Date.now();
 let health={quarantined:false,active:[{kind:'detail',campaignId:'400001',startedAt:now-180000,deadline:now+120000,lastStep:'page.evaluate'}]};
 const platform={progress:{stage:'核对当前活动',at:now-180000}};
 const service={running:true,busy:true,status:()=>({version:'2.0.0-beta.30',readHealth:health,unknown:0,verified:0,blocked:0,tasks:[],patrolStartedAt:now-240000,lastRun:service.lastRun}),stop(){this.running=false;this.busy=false;}};
 const app=await createApp({config:{shopId:'900001',name:'健康隔离测试'},port:0,runtime:join(runtime,'server'),dependencies:{journal,service,
  platform,browser:{close:async()=>{}}}});
 try{
  await browser.open('900001');const page=await browser.page();
  await page.addInitScript(()=>{window.guardianDesktop={version:'2.0.0-beta.33',onUpdate:()=>{},updateStatus:async()=>({state:'idle'})};});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='读取较慢');
  assert.equal(await page.locator('#version').innerText(),'后台 v2.0.0-beta.30');assert.match(await page.locator('#update-version').innerText(),/后台尚未切换/);
  assert.equal(await page.locator('#progress').innerText(),'正在核对商品活动');assert.match(await page.locator('#schedule').innerText(),/本轮进行中.*开始：.*上次成功：/);
  const technical=/400001|page\.evaluate|\bdetail\b|\blist\b|步骤|读取期限|业务进度已等待|deadline/;
  assert.doesNotMatch(await page.locator('.patrol').innerText(),technical);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/beta61-read-health-plain-activity.png'),fullPage:false,animations:'disabled'});
  platform.progress={stage:'读取当前完整规格',at:Date.now()};health={quarantined:false,active:[{kind:'list',campaignId:'400001',startedAt:Date.now(),deadline:Date.now()+175000,lastStep:'page.evaluate'}]};
  await page.waitForFunction(()=>document.querySelector('#progress')?.textContent==='正在读取当前规格');assert.doesNotMatch(await page.locator('.patrol').innerText(),technical);
  const raw=await(await fetch(app.url+'/api/status')).json();assert.equal(raw.readHealth.active[0].lastStep,'page.evaluate');assert.equal(raw.readHealth.active[0].kind,'list');
  await page.screenshot({path:resolve('artifacts/beta61-read-health-plain-skus.png'),fullPage:false,animations:'disabled'});
  health={quarantined:true,active:[]};await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='清理待核实');
  assert.match(await page.locator('#progress').innerText(),/修复只读后台/);
  health={quarantined:false,active:[]};service.running=false;service.busy=false;service.lastRun={ok:false,code:'LOGIN_REQUIRED'};
  await page.waitForFunction(()=>document.querySelector('#patrol-status')?.textContent==='需要登录');assert.match(await page.locator('#progress').innerText(),/重新登录/);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
