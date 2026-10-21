import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';
import {dateControlSnapshot} from '../../src/date-control-snapshot.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
test('date diagnosis records visible non-dropdown DOM without modifying the form or copying hidden secrets',async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();try{
  await page.setContent('<input readonly placeholder="开始日期" value="2026/10/21 10:00:00"><input readonly placeholder="结束日期" value="2026/11/18 10:00:07"><input type="hidden" value="do-not-export"><script>window.secret="do-not-export";window.changed=0;document.addEventListener("input",()=>window.changed++);document.addEventListener("click",()=>window.changed++);</script><div class="fixture-calendar-popup"><button class="fixture-next-month" aria-label="下个月">下一月</button><table><tr><td title="2026-11-18" class="fixture-calendar-day">18</td></tr></table><ul class="fixture-time-seconds"><li aria-selected="true">07</li></ul></div><div class="picker-dropdown" hidden>obsolete</div>');
  const snapshot=await page.evaluate(dateControlSnapshot);assert.equal(snapshot.diagnosticOnly,true);
  assert.equal(snapshot.inputs[1].value,'2026/11/18 10:00:07');assert.equal(snapshot.inputs[0].readonly,true);
  const panel=snapshot.panels.find(p=>p.className==='fixture-calendar-popup');assert.ok(panel);
  assert.ok(panel.controls.some(c=>c.title==='2026-11-18'));assert.ok(panel.controls.some(c=>c.ariaSelected==='true'&&c.text==='07'));
  assert.equal(snapshot.legacyDropdownMatches[0].visible,false);assert.doesNotMatch(JSON.stringify(snapshot),/do-not-export/);
  assert.equal(await page.evaluate(()=>window.changed),0);
 }finally{await browser.close();}
});
test('a date preparation failure preserves real date controls alongside the failure evidence',async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();try{
  await page.setContent('<input id="title"><input readonly placeholder="开始日期" value="2026/10/21 10:00:00"><input readonly placeholder="结束日期" value="2026/11/18 10:00:07"><div class="fixture-calendar-popup"><button aria-label="下个月">下一月</button><table><tr><td title="2026-11-18">18</td></tr></table></div>');
  let captured;await DoudianPlatform.prototype.fault.call({browser:{failure:async(_page,_task,_stage,_error,observation)=>{captured=observation;}}},page,'local-test','prepare',new Error('locator picker-dropdown waitFor timeout'));
  assert.equal(captured.dateControls.diagnosticOnly,true);assert.ok(captured.dateControls.panels.some(p=>p.className==='fixture-calendar-popup'));
 }finally{await browser.close();}
});
