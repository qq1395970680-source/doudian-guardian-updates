import {requireThat} from './policy.mjs';
import {parseDate,until} from './collector.mjs';

// Use the platform's visible range-picker controls. The temporary shortcut
// anchors both time-of-day values to the same current instant; only the final,
// exactly verified duration may leave this function and reach submission.
export async function chooseReadonlyDateRange(page,durationMs){
 const fail=message=>requireThat(false,'DRAFT_TIME_READONLY',message+'；未提交');
 const start=page.locator('input[placeholder="开始日期"]'),end=page.locator('input[placeholder="结束日期"]');
 if(!Number.isSafeInteger(durationMs)||durationMs%1000!==0||durationMs<=0)
  fail('只读日期选择器暂不能核对该自定义时长，保留原活动时长');
 const panel=page.locator('[class*="picker-dropdown"]:visible');
 await start.click();
 await panel.waitFor({state:'visible',timeout:3000});
 if(await panel.count()!==1||!await panel.locator('td[title][class*="picker-cell-in-view"]').count())
  fail('未识别到可核对的日期日历，保留原活动时长');
 const commit=async()=>{
  const confirm=panel.getByRole('button',{name:/^确\s*定$/});
  if(await confirm.count()===1)await confirm.click();
  await page.locator('#title').click();
 };
 let anchorDuration=null;
 for(const [label,duration] of [['近1天',86400000],['近7天',7*86400000],['近48小时',48*3600000]]){
  const option=panel.getByText(label,{exact:true});
  if(await option.count()===1&&await option.isVisible()){anchorDuration=duration;await option.click();await commit();break;}
 }
 if(anchorDuration===null)fail('未找到用于核对起始时间的日期选项');
 const read=async()=>[parseDate(await start.inputValue()),parseDate(await end.inputValue())];
 const anchor=await until(async()=>{
  const d=await read();return d[1]-d[0]===anchorDuration&&d[0]>Date.now()-240000&&d[0]<=Date.now()+300000&&d;
 },'日期起始时间尚未生效，未提交',5000);
 const target=anchor[0]+durationMs,date=new Date(target+8*3600000).toISOString().slice(0,10);
 await end.click();await panel.waitFor({state:'visible',timeout:3000});
 let selected=false;
 for(let attempt=0;attempt<Math.ceil(durationMs/(28*86400000))+3;attempt++){
  const cells=panel.locator('td[class*="picker-cell-in-view"][title]');
  // Match the complete calendar date, excluding duplicate outside-month cells.
  const targetCell=panel.locator(`td[class*="picker-cell-in-view"][title="${date}"]`);
  const count=await targetCell.count();
  if(count>1)fail('目标日期不唯一');
  if(count===1){
   if(/disabled/.test(await targetCell.getAttribute('class')||'')||await targetCell.getAttribute('aria-disabled')==='true')fail('平台不允许原活动对应的结束日期');
   await targetCell.click();selected=true;break;
  }
  const visibleDates=(await cells.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('title')))).filter(s=>/^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  if(!visibleDates.length)fail('日历没有可核对的完整日期');
  const direction=date>visibleDates.at(-1)?'next':date<visibleDates[0]?'prev':null;
  if(!direction)fail('日历未显示目标日期');
  const navigation=panel.locator(`button[class*="picker-header-${direction}-btn"]:visible`);
  const n=await navigation.count();if(!n||n>2)fail('日期翻月入口不明确');
  const control=navigation.nth(direction==='next'?n-1:0);
  if(!await control.isEnabled())fail('平台不允许切换到目标月份');
  const before=visibleDates.join(',');await control.click();
  await until(async()=>(await cells.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('title')).sort())).join(',')!==before,'日期翻月尚未生效',3000);
 }
 if(!selected)fail('未能选择原活动对应的结束日期');
 if(durationMs%86400000!==0){
  // The end input was explicitly activated before selecting its calendar date.
  // Work through the visible time controls, never mutate readonly inputs.
  const timePanel=panel.locator('[class*="picker-time-panel"]:not([class*="picker-time-panel-"]):visible');
  if(!await timePanel.count()){
   const toggle=panel.getByText('选择时间',{exact:true}).filter({visible:true});
   if(await toggle.count()!==1)fail('结束时间选择入口缺失或不唯一');
   await toggle.click();
  }
  if(await timePanel.count()!==1)fail('结束时分秒面板缺失或不唯一');
  const columns=timePanel.locator('[class*="picker-time-panel-column"]');
  if(await columns.count()!==3)fail('结束时间的时分秒列不完整');
  const parts=new Date(target+8*3600000).toISOString().slice(11,19).split(':');
  for(let index=0;index<3;index++){
   const column=columns.nth(index),cell=column.locator('li').filter({hasText:new RegExp(`^\\s*${parts[index]}\\s*$`)});
   if(await cell.count()!==1)fail('结束时间选项缺失或不唯一');
   if(/disabled/.test(await cell.getAttribute('class')||'')||await cell.getAttribute('aria-disabled')==='true')fail('平台不允许原活动对应的结束时分秒');
   await cell.click();
   await until(async()=>/cell-selected/.test(await cell.getAttribute('class')||'')||await cell.getAttribute('aria-selected')==='true','结束时分秒选择尚未生效，未提交',3000);
  }
 }
 await commit();
 await until(async()=>{const d=await read();return d[0]===anchor[0]&&d[1]===target;},'日历实际日期或时分秒与原活动时长不一致，未提交',5000);
}
