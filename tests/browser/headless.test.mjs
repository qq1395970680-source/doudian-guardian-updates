import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';

const html=`<!doctype html><meta charset="utf-8"><style>.dialog{animation:exit .15s forwards}@keyframes exit{from{opacity:1}to{opacity:0}}</style><body>
<label><input type="radio" name="mode" value="online" checked>在线选择</label><label><input type="radio" name="mode" value="excel">Excel批量导入</label>
<button id="select">添加商品</button><p id="count">0</p><div id="dialog" hidden>确认切换吗<button id="confirm">确定</button></div>
<script>let selected=0;document.querySelector('#select').onclick=()=>{selected=1;document.querySelector('#count').textContent=selected;};
document.querySelector('[value=excel]').onchange=()=>{if(selected)document.querySelector('#dialog').hidden=false;};
document.querySelector('#confirm').onclick=()=>{selected=0;document.querySelector('#count').textContent=0;document.querySelector('#dialog').className='dialog';};
document.querySelector('#dialog').addEventListener('animationend',e=>{document.body.dataset.trusted=String(e.isTrusted);document.querySelector('#dialog').hidden=true;});
requestAnimationFrame(()=>document.body.dataset.frame='yes');</script>`;

for(const viewport of [{width:1440,height:960},{width:960,height:600}])test(`native headless renders separate drafts and native exit events at ${viewport.width}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-v2-browser-')),browser=new DedicatedBrowser(root,{viewport,test:true});
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await browser.open('900001');const url='http://127.0.0.1:'+server.address().port;
  const readPage=await browser.page();await readPage.goto(url);await readPage.locator('#select').click();
  assert.equal(await readPage.locator('#count').innerText(),'1');
  const writePage=await browser.page();await writePage.goto(url);await writePage.locator('[value=excel]').check();
  assert.equal(await writePage.locator('#count').innerText(),'0');assert.equal(await writePage.locator('#dialog').isVisible(),false);
  for(const page of [readPage,writePage]){assert.equal(await page.evaluate(()=>document.visibilityState),'visible');assert.equal(await page.locator('body').getAttribute('data-frame'),'yes');}
  // A normal CSS exit lifecycle also completes without any injected clock.
  await readPage.locator('[value=excel]').check();await readPage.locator('#confirm').click();
  await readPage.locator('#dialog').waitFor({state:'hidden'});assert.equal(await readPage.locator('body').getAttribute('data-trusted'),'true');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
