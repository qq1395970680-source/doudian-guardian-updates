import {requireThat} from './policy.mjs';
import {parseDate,until} from './collector.mjs';

// Structure inspected on the live marketing form: two calendar panels, div
// day cells without title attributes, and separate start/end time pickers.
export async function chooseArcoDateRange(page,durationMs){
 const check=(ok,message)=>requireThat(ok,'DRAFT_TIME_READONLY',message+'；未提交');
 const panel=page.locator('.arco-picker-range-container:visible');
 const fields=[page.getByPlaceholder('开始日期',{exact:true}),page.getByPlaceholder('结束日期',{exact:true})];
 const read=async()=>Promise.all(fields.map(async f=>parseDate(await f.inputValue())));
 const fmt=t=>new Date(t+8*3600000).toISOString();
 check(await panel.count()===1,'日期弹窗不唯一');
 const commit=async()=>{const b=panel.locator('.arco-picker-btn-confirm');check(await b.count()===1&&await b.isEnabled(),'日期确认入口不可用');await b.click();await panel.waitFor({state:'hidden',timeout:5000});};
 let anchorDuration;
 for(const [label,value]of [['近1天',86400000],['近7天',604800000],['近48小时',172800000]]){
  const b=panel.getByRole('button',{name:label,exact:true});
  if(await b.count()===1){anchorDuration=value;await b.click();await panel.waitFor({state:'hidden',timeout:5000});break;}
 }
 check(!!anchorDuration,'起始时间快捷项缺失');
 const anchor=await read();
 check(anchor[1]-anchor[0]===anchorDuration&&anchor[0]>Date.now()-240000&&anchor[0]<=Date.now()+300000,'起始时间尚未核对');
 const target=anchor[0]+durationMs,iso=fmt(target);
 // Reopening an Arco range and clicking one date clears the opposite endpoint.
 // Select the complete pair in order; never assume an existing start survives.
 await fields[0].click();await panel.waitFor({state:'visible',timeout:5000});
 const selectDay=async(time,side)=>{
 const [year,month,day]=fmt(time).slice(0,10).split('-').map(Number);
 check(await fields[side].locator('..').evaluate(e=>e.classList.contains('arco-picker-input-active')),'日期端点未激活');
 let chosen=false;
 for(let i=0;i<Math.ceil(durationMs/2419200000)+4;i++){
  const calendars=panel.locator('.arco-panel-date-inner:visible');
  check(await calendars.count()===2,'双月日历结构不完整');
  const headers=await calendars.locator('.arco-picker-header-value').allTextContents();
  const months=headers.map(s=>s.match(/^(\d{4})年\s*(\d{1,2})月$/)).map(m=>m?Number(m[1])*12+Number(m[2]):NaN);
  check(months.length===2&&months.every(Number.isFinite)&&months[1]===months[0]+1,'日历年月无法唯一核对');
  const wanted=year*12+month,index=months.indexOf(wanted);
  if(index!==-1){
   const cell=calendars.nth(index).locator('.arco-picker-cell-in-view').filter({hasText:new RegExp('^\\s*'+day+'\\s*$')});
   check(await cell.count()===1,'结束日期单元格不唯一');
   check(!/disabled/.test(await cell.getAttribute('class')||'')&&await cell.getAttribute('aria-disabled')!=='true','平台不允许该结束日期');
   await cell.click();chosen=true;break;
  }
  const direction=wanted>months[1]?'right':'left';
  const nav=calendars.locator('.arco-picker-header-icon:not(.arco-picker-header-icon-hidden)').filter({has:page.locator('.arco-icon-'+direction)});
  check(await nav.count()===1,'翻月入口不唯一');await nav.click();
  await until(async()=>(await calendars.locator('.arco-picker-header-value').allTextContents()).join()!==headers.join(),'翻月未生效',5000);
 }
 check(chosen,'未找到目标年月日');
 };
 await selectDay(anchor[0],0);
 await selectDay(target,1);
 // Restore both anchored time values after selecting the complete date pair;
 // selecting a date can replace its time with the platform's current time.
 const toggle=panel.getByRole('button',{name:'选择时间',exact:true});
 check(await toggle.count()===1,'时间选择入口不唯一');await toggle.click();
 const times=panel.locator('.arco-timepicker:visible');
 await until(async()=>await times.count()===2,'时分秒面板未完整打开',5000);
 for(let side=0;side<2;side++){
 const columns=times.nth(side).locator('.arco-timepicker-list');
 check(await columns.count()===3,'结束时分秒列不完整');
 const parts=fmt(side===0?anchor[0]:target).slice(11,19).split(':');
 for(let i=0;i<3;i++){
  const cell=columns.nth(i).locator('li.arco-timepicker-cell').filter({hasText:new RegExp('^'+parts[i]+'$')});
  check(await cell.count()===1,'结束时分秒选项不唯一');
  check(!/disabled/.test(await cell.getAttribute('class')||'')&&await cell.getAttribute('aria-disabled')!=='true','平台不允许该结束时间');
  await cell.click();await until(async()=>(await cell.getAttribute('class')||'').split(' ').includes('arco-timepicker-cell-selected'),'时分秒选择未生效',5000);
 }
 }
 const selections=await times.evaluateAll(es=>es.map(e=>[...e.querySelectorAll('.arco-timepicker-cell-selected')].map(n=>n.textContent.trim()).join(':')));
 check(selections[0]===fmt(anchor[0]).slice(11,19)&&selections[1]===iso.slice(11,19),'起止时分秒核对不一致');
 await commit();
 await until(async()=>{const d=await read();return d[0]===anchor[0]&&d[1]===target;},'日历完整日期与时分秒不一致，未提交',5000);
}
