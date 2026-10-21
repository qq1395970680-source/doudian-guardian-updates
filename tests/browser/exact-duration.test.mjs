import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {DoudianPlatform} from '../../src/platform.mjs';
import {parseDate} from '../../src/collector.mjs';
import {installDateTimeFixture} from './date-time-fixture.mjs';

for(const type of ['限量抢购','限时抢购'])for(const scenario of ['custom7seconds','minute-carry','midnight-carry','shortcut48'])
test(`exact readonly duration ${type} ${scenario}`,async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();page.setDefaultTimeout(1200);
 try{
  const start=Math.floor(Date.now()/1000)*1000;
  const seconds=new Date(start).getUTCSeconds();
  const days=type==='限量抢购'?28:2;
  const duration=['custom7seconds','shortcut48'].includes(scenario)?days*86400000+7000:scenario==='minute-carry'?86400000+(67-seconds)*1000:days*86400000+86400000-((start+8*3600000)%86400000)+7000;
  await page.setContent('<input id="title"><input placeholder="开始日期"><input placeholder="结束日期">');
  await page.evaluate(installDateTimeFixture,{start,duration,mode:scenario});
  await DoudianPlatform.prototype.setDates.call({},page,{type,durationMs:duration});
  assert.equal(parseDate(await page.getByPlaceholder('开始日期').inputValue()),start);
  assert.equal(parseDate(await page.getByPlaceholder('结束日期').inputValue()),start+duration);
  const clicks=await page.evaluate(()=>window.timeClicks);assert.ok(clicks.length>=3);assert.ok(clicks.every(c=>c.side===1));
  assert.equal(await page.evaluate(()=>window.fieldInputEvents),0);assert.equal(await page.locator('input[readonly]').count(),2);
 }finally{await browser.close();}
});
for(const mode of ['disabled-time','missing-column','ambiguous-time','ignored-time','changed-start','wrong-final'])
test(`readonly exact time fails closed: ${mode}`,async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();page.setDefaultTimeout(1200);
 try{
  const start=Math.floor(Date.now()/1000)*1000;await page.setContent('<input id="title"><input placeholder="开始日期"><input placeholder="结束日期">');
  await page.evaluate(installDateTimeFixture,{start,duration:2419207000,mode});
  await assert.rejects(()=>DoudianPlatform.prototype.setDates.call({},page,{type:'限量抢购',durationMs:2419207000}));
 }finally{await browser.close();}
});
