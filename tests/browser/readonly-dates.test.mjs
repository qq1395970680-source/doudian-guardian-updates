import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {DoudianPlatform} from '../../src/platform.mjs';

const format=t=>new Date(t+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');
test('readonly limited dates use the visible seven-day shortcut and commit the picker',async()=>{
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(1500);
 try{
  const start=Math.floor(Date.now()/1000)*1000;
  await page.setContent(`<input id="title"><input readonly placeholder="开始日期" value="${format(start)}"><input readonly placeholder="结束日期" value="${format(start+86400000)}"><div class="ecom-mcenter-picker-dropdown" hidden><span id="week">近7天</span><button id="confirm">确定</button></div><script>
   window.fills=0;window.commits=0;const fields=document.querySelectorAll('input[readonly]');for(const f of fields)f.addEventListener('input',()=>window.fills++);
   fields[0].onclick=()=>document.querySelector('.ecom-mcenter-picker-dropdown').hidden=false;
   document.querySelector('#week').onclick=()=>window.chosen=true;
   document.querySelector('#confirm').onclick=()=>{if(!window.chosen)return;fields[1].value=${JSON.stringify(format(start+7*86400000))};window.commits++;document.querySelector('.ecom-mcenter-picker-dropdown').hidden=true;};</script>`);
  await DoudianPlatform.prototype.setDates.call({},page,{type:'限量抢购',durationMs:7*86400000});
  assert.equal(await page.locator('input[placeholder="结束日期"]').inputValue(),format(start+7*86400000));
  assert.deepEqual(await page.evaluate(()=>({fills:window.fills,commits:window.commits,readonly:[...document.querySelectorAll('input[readonly]')].length})),{fills:0,commits:1,readonly:2});
 }finally{await browser.close();}
});

for(const mode of ['already-correct','one-day','wrong-shortcut','unsupported-duration','editable-custom','disabled'])
test(`limited date boundaries: ${mode}`,async()=>{
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(1000);
 try{
  const start=Math.floor(Date.now()/1000)*1000,duration=mode==='one-day'?86400000:mode==='unsupported-duration'||mode==='editable-custom'?3*86400000:7*86400000;
  const initial=mode==='already-correct'?duration:2*86400000;
  await page.setContent(`<input id="title"><input ${mode==='editable-custom'?'':'readonly'} ${mode==='disabled'?'disabled':''} placeholder="开始日期" value="${format(start)}"><input ${mode==='editable-custom'?'':'readonly'} placeholder="结束日期" value="${format(start+initial)}"><div class="ecom-mcenter-picker-dropdown" hidden><a id="quick">近${mode==='one-day'?1:7}天</a></div><script>
  window.clicked=0;const fields=document.querySelectorAll('input[placeholder]');fields[0].onclick=()=>{window.clicked++;document.querySelector('.ecom-mcenter-picker-dropdown').hidden=false;};
  document.querySelector('#quick').onclick=()=>{fields[1].value=${JSON.stringify(format(start+(mode==='wrong-shortcut'?86400000:duration)))};document.querySelector('.ecom-mcenter-picker-dropdown').hidden=true;};</script>`);
  const run=()=>DoudianPlatform.prototype.setDates.call({},page,{type:'限量抢购',durationMs:duration});
  if(mode==='unsupported-duration')await assert.rejects(run,{code:'DRAFT_TIME_READONLY'});
  else if(mode==='wrong-shortcut')await assert.rejects(run,{code:'LOAD_TIMEOUT'});
  else if(mode==='disabled')await assert.rejects(run,{code:'DRAFT_TIME'});
  else {await run();if(mode==='already-correct')assert.equal(await page.evaluate(()=>window.clicked),0);
   const dates=await page.locator('input[placeholder]').evaluateAll(nodes=>nodes.map(n=>n.value));
   const parse=s=>Date.parse(s.replaceAll('/','-').replace(' ','T')+'+08:00');assert.equal(parse(dates[1])-parse(dates[0]),duration);}
 }finally{await browser.close();}
});

for(const mode of ['thirty-days','wrong-time','disabled-day'])
test(`readonly calendar preserves the original month duration: ${mode}`,async()=>{
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(1000);
 try{
  const start=Math.floor(Date.now()/1000)*1000,end=start+30*86400000,date=format(end).slice(0,10).replaceAll('/','-');
  await page.setContent(`<input id="title"><input readonly placeholder="开始日期" value="${format(start)}"><input readonly placeholder="结束日期" value="${format(start+86400000)}"><div class="ecom-mcenter-picker-dropdown" hidden><a id="week">近7天</a><table><tr><td title="${date}" class="ecom-mcenter-picker-cell"><div>outside month</div></td><td title="${date}" class="ecom-mcenter-picker-cell ecom-mcenter-picker-cell-in-view ${mode==='disabled-day'?'ecom-mcenter-picker-cell-disabled':''}"><div>target date</div></td></tr></table><button id="confirm">确定</button></div><script>
   window.endSelected=0;window.commits=0;window.inputEvents=0;const f=document.querySelectorAll('input[placeholder]'),picker=document.querySelector('.ecom-mcenter-picker-dropdown');let selected=null;
   for(const input of f){input.onclick=()=>picker.hidden=false;input.addEventListener('input',()=>window.inputEvents++);}
   document.querySelector('#week').onclick=()=>selected=${JSON.stringify(format(start+7*86400000))};
   document.querySelector('.ecom-mcenter-picker-cell-in-view').onclick=()=>{window.endSelected++;selected=${JSON.stringify(format(end+(mode==='wrong-time'?1000:0)))};};
   document.querySelector('#confirm').onclick=()=>{if(selected){f[1].value=selected;window.commits++;}picker.hidden=true;};
  </script>`);
  const run=()=>DoudianPlatform.prototype.setDates.call({},page,{type:'限量抢购',durationMs:30*86400000});
  if(mode==='wrong-time')await assert.rejects(run,{code:'LOAD_TIMEOUT'});
  else if(mode==='disabled-day')await assert.rejects(run,{code:'DRAFT_TIME_READONLY'});
  else {await run();assert.equal(await page.locator('input[placeholder="结束日期"]').inputValue(),format(end));assert.equal(await page.evaluate(()=>window.endSelected),1);assert.equal(await page.evaluate(()=>window.inputEvents),0);}
 }finally{await browser.close();}
});
