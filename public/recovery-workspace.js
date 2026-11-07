import {isFixedPrice} from './price-display.js';
// One product, one row. Only the service can classify a confirmed reduction.
export function createRecoveryWorkspace({getState,post,toast,node,time,openPricing}){
 const $=id=>document.getElementById(id);
 let shop,scope='confirm',page=0,pages=1,loading=false,generation=0,signature='',searchTimer;
 const copy={
  confirm:['待确认降价','可用方案已核实需要降价。查看各方案的原因和确切价格后，由你决定。','当前没有需要你确认的降价','有一种方案可不降价恢复时，后台会优先处理；尚未核验完的放在自动核验。'],
  automatic:['自动核验','后台继续核验两种活动。提交结果未明确时只做回读，不重复提交。','当前没有正在核验的恢复事项','后续需要核验的商品会显示在这里。'],
  history:['已处理','查看本次恢复事项的处理记录。历史价格仅供查看，当前活动以最新回读为准。','暂无处理记录','已确认或暂不调整的事项会保留在这里。']
 };
 const labels={verification:'提交结果核实中',processing:'后台处理中','read-blocked':'等待重新读取','needs-evidence':'活动方案核验中','setup-required':'等待启用双方案',declined:'已选择暂不调整',approved:'已确认降价',verified:'已回读完成',pending:'活动方案核验中'};
 function headings(){
  for(const button of document.querySelectorAll('[data-workspace-scope]')){
   const selected=button.dataset.workspaceScope===scope;button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
  }
  $('price-direction-title').textContent=copy[scope][0];$('price-direction-detail').textContent=scope==='automatic'&&getState().state?.dualActivityCareEnabled!==true?'尚未启用双方案，请先在店铺管理明确授权。原有规则按已有授权继续运行。':copy[scope][1];
 }
 function reset(){signature='';const empty=node('div','empty');if(shop)empty.textContent='正在读取'+copy[scope][0];else empty.append(node('strong','','先连接店铺'),node('p','','连接店铺后，恢复事项会自动显示在这里。'));$('price-reviews').replaceChildren(empty);$('price-page-label').textContent=shop?'正在读取':'连接后自动读取';$('price-prev').disabled=true;$('price-next').disabled=true;}
 function counts(value){
  for(const type of ['confirm','automatic','history'])$('workspace-'+type+'-count').textContent=Number.isInteger(value?.[type])?String(value[type]):'—';
  const attention=Number.isInteger(value?.confirm)?value.confirm:0;$('price-count').textContent=String(attention);$('price-count').hidden=!attention;
 }
 function render(result){
  const renderedScope=scope;page=result.page;pages=result.pages;counts(result.counts);
  $('price-page-label').textContent=`${result.total} 件商品 · 第 ${page+1} / ${pages} 页`;$('price-prev').disabled=page===0;$('price-next').disabled=page>=pages-1;
  const current=getState(),next=JSON.stringify([shop,scope,result.records,!!current.online,current.state?.connection?.shopId]);if(signature===next)return;signature=next;
  const rows=(result.records||[]).map(record=>{
   const row=node('article','workspace-row'),body=node('div','workspace-row-copy'),heading=node('div','workspace-row-heading');row.dataset.workspaceProduct=record.productId;row.dataset.priceProduct=record.productId;if(record.reviewId||record.pricingReviewId)row.dataset.reviewId=record.reviewId||record.pricingReviewId;
   const status=renderedScope==='confirm'?'两种活动均需降价':record.statusLabel||labels[record.category]||labels[record.verificationState]||(renderedScope==='history'?'已处理':'后台核验中');
   heading.append(node('strong','',record.name||'商品 '+record.productId),node('span','badge '+(renderedScope==='confirm'?'amber':renderedScope==='automatic'?'blue':'neutral'),status));
   const summary=record.summary||record.message||(renderedScope==='automatic'?'后台会继续核对平台状态，无需重复操作。':'打开查看当时的处理记录。');
   body.append(heading,node('p','workspace-row-summary',String(summary).replace(/^[A-Z_]+:\s*/,'')),node('small','workspace-row-meta','商品 '+record.productId+(isFixedPrice(record)?' · 一口价':'')+(record.updatedAt?' · '+time(record.updatedAt):'')));
   const actions=node('div','workspace-row-actions'),button=node('button','button small '+(renderedScope==='confirm'?'primary':'secondary'),renderedScope==='confirm'?'核对降价':renderedScope==='history'?'查看记录':'查看核验');button.dataset.openPriceReview=record.productId;
   button.onclick=()=>openPricing({...record,reviewId:renderedScope==='history'?record.reviewId:null,history:renderedScope==='history'});actions.append(button);
   if(renderedScope==='automatic'&&record.canRecheck===true){const retry=node('button','text-button','重新核验');retry.disabled=!current.online||current.state?.connection?.shopId!==shop;retry.onclick=async()=>{retry.disabled=true;try{await post('recovery/request',{shopId:shop,productId:record.productId});toast('已请求重新核验，后台会继续处理。');}catch(error){toast(error.message);}finally{signature='';void refresh();}};actions.append(retry);}
   row.append(body,actions);return row;
  });
  if(!rows.length){const empty=node('div','empty'),searching=$('workspace-search').value.trim().length>0;empty.append(node('strong','',searching?'没有找到匹配的商品':copy[scope][2]),node('p','',searching?'试试其他商品名称或 ID，或清空搜索。':copy[scope][3]));rows.push(empty);}$('price-reviews').replaceChildren(...rows);
 }
 async function refresh(){
  if(loading||!shop)return;loading=true;const expected=generation,expectedShop=shop,expectedScope=scope;
  try{const response=await fetch(`/api/recovery-workspace?scope=${scope}&page=${page}&q=${encodeURIComponent($('workspace-search').value)}`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();const result=await response.json();if(expected!==generation||expectedShop!==shop||result.shopId!==shop||result.scope&&result.scope!==expectedScope)return;$('workspace-feedback').hidden=true;render(result);}
  catch{if(expected===generation){$('workspace-feedback').hidden=false;$('workspace-feedback').textContent='恢复事项暂时无法读取，正在重新连接。';}}
  finally{loading=false;if(expected!==generation)void refresh();}
 }
 function select(next){if(!copy[next])return;scope=next;page=0;generation++;headings();reset();void refresh();}
 const tabs=[...document.querySelectorAll('[data-workspace-scope]')];for(const [index,button] of tabs.entries()){
  button.onclick=()=>select(button.dataset.workspaceScope);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();select(tabs[next].dataset.workspaceScope);};
 }
 $('price-prev').onclick=()=>{page=Math.max(0,page-1);generation++;void refresh();};$('price-next').onclick=()=>{page=Math.min(pages-1,page+1);generation++;void refresh();};
 $('workspace-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=0;generation++;reset();void refresh();},250);};
 return{sync(){const state=getState().state,next=state?.shopId||null;if(shop!==next){shop=next;scope='confirm';page=0;generation++;$('workspace-search').value='';reset();}headings();if(state?.recoveryWorkspaceCounts)counts(state.recoveryWorkspaceCounts);},refresh,select};
}
