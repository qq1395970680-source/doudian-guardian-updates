import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {chooseReadonlyDateRange} from '../../src/date-picker.mjs';
import {parseDate} from '../../src/collector.mjs';

// DOM contracts captured in artifacts/beta28-live/calendar.html and time.html.
// Range shortcut closes itself; day divs have no title; both time endpoints
// coexist. Each interaction changes only its own date/time component.
import {installArcoDateFixture as install} from './arco-date-fixture.mjs';
for(const mode of ['28days7seconds','minute-carry','midnight-carry','next-month','disabled-day','disabled-time','missing-end','wrong-final','changed-start'])
test('real Arco structure '+mode,async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();page.setDefaultTimeout(1500);
 try{
  const start=Math.floor(Date.now()/1000)*1000;
  const duration=mode==='minute-carry'?86400000+(67-new Date(start).getUTCSeconds())*1000:mode==='midnight-carry'?86400000-(start+28800000)%86400000+7000:mode==='next-month'?62*86400000+7000:2419207000;
  await page.evaluate(install,{start,mode});
  const run=()=>chooseReadonlyDateRange(page,duration);
  if(['disabled-day','disabled-time','missing-end','wrong-final','changed-start'].includes(mode))await assert.rejects(run);
  else{await run();assert.equal(parseDate(await page.getByPlaceholder('开始日期').inputValue()),start);assert.equal(parseDate(await page.getByPlaceholder('结束日期').inputValue()),start+duration);assert.deepEqual((await page.evaluate(()=>window.timeChanges)).map(x=>x.side),[0,0,0,1,1,1]);if(mode==='next-month')assert.ok(await page.evaluate(()=>window.navigation)>0);}
  assert.equal(await page.evaluate(()=>window.inputEvents),0);assert.equal(await page.locator('input[readonly]').count(),2);
 }finally{await browser.close();}
});
