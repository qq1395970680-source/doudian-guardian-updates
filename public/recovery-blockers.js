// Execution/read problems live here; price approval uses the shared drawer.
export function createRecoveryBlockers({getState,post,toast,node,time,openPricing}){
 const $=id=>document.getElementById(id);let shop=undefined,filter='all',page=0,pages=1,loading=false,generation=0,signature='';
 const states={verification:'结果核实中',processing:'后台处理中','read-blocked':'读取或校验受阻','needs-evidence':'等待补充核验',declined:'暂不调整价格'};
 function render(result){
  $('blocker-both-count').textContent=result.counts.bothBlocked;$('blocker-other-count').textContent=result.counts.total-result.counts.bothBlocked;$('blocker-page-label').textContent=`${result.total} 件 · 第 ${result.page+1} / ${result.pages} 页`;page=result.page;pages=result.pages;$('blocker-prev').disabled=page===0;$('blocker-next').disabled=page>=pages-1;
  const current=getState(),next=JSON.stringify([result,!!current.online,current.state?.connection?.shopId]);if(signature===next)return;signature=next;
  const rows=result.records.map(record=>{
   const row=node('article','panel blocker-card'),head=node('div','section-head'),body=node('div'),status=states[record.category]||(record.state==='verifying'?'结果核实中':'等待核验');row.dataset.recoveryBlocker=record.productId;
   body.append(node('h2','',record.name||'商品 '+record.productId));head.append(body,node('span','badge '+(['verification','processing'].includes(record.category)?'blue':'amber'),status));row.append(head);
   const reason=record.category==='verification'?'上次提交结果尚未明确，后台只做独立回读，不重复提交。':record.blockedReason||record.message||'后台会继续核对平台状态。';row.append(node('p','blocker-summary',String(reason).replace(/^[A-Z_]+:\s*/,'').split('\n')[0]));
   const details=node('details','blocker-details'),summary=node('summary','','查看原因与核验进度');details.append(summary,node('p','helper','商品 '+record.productId+' · 更新 '+time(record.updatedAt)));
   if(record.code)details.append(node('p','helper','核验提示：'+record.code));
   if(record.recheck)details.append(node('p','helper','恢复请求：'+(record.recheck.state||'正在处理')+' · '+time(record.recheck.updatedAt||record.recheck.requestedAt)));
   for(const type of ['限时抢购','限量抢购']){const scheme=record.schemes?.[type];if(scheme)details.append(node('p','helper',type+'：'+scheme.message+(scheme.outdated?'（旧价格目标记录）':'')+(scheme.at?' · '+time(scheme.at):'')));}row.append(details);
   const actions=node('div','button-row');
   if(record.priceReview){const price=node('button','button small secondary','查看价格方案');price.dataset.openPriceReview=record.productId;price.onclick=()=>openPricing(record);actions.append(price);}
   const waiting=record.category==='verification'||record.state==='verifying',queued=record.category==='processing'&&['pending','queued','verifying'].includes(record.recheck?.state);
   if(!waiting&&!queued){const retry=node('button','button small secondary','现在重新核验');retry.disabled=!current.online||current.state?.connection?.shopId!==shop;retry.onclick=async()=>{retry.disabled=true;try{await post('recovery/request',{shopId:shop,productId:record.productId});toast('已加入核验队列，后台会继续处理。');}catch(error){toast(error.message);}finally{signature='';void refresh();}};actions.append(retry);}else actions.append(node('small','helper','后台继续核验，无需重复操作'));
   if(actions.childElementCount)row.append(actions);return row;
  });$('blocker-records').replaceChildren(...(rows.length?rows:[node('div','panel empty','当前没有需要补充核验的商品。需要确认的价格统一在价格确认查看。')]));
 }
 async function refresh(){if(loading||!shop)return;loading=true;const expected=generation,expectedShop=shop;try{const response=await fetch(`/api/recovery-blockers?filter=${filter}&page=${page}&q=${encodeURIComponent($('blocker-search').value)}`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();const result=await response.json();if(result.shopId!==expectedShop||expected!==generation)return;$('blocker-feedback').hidden=true;render(result);}catch{$('blocker-feedback').hidden=false;$('blocker-feedback').textContent='核验记录暂时无法读取，正在重新连接。';}finally{loading=false;if(expected!==generation)void refresh();}}
 for(const button of document.querySelectorAll('[data-blocker-filter]'))button.onclick=()=>{filter=button.dataset.blockerFilter;page=0;generation++;signature='';for(const b of document.querySelectorAll('[data-blocker-filter]'))b.classList.toggle('selected',b===button);void refresh();};
 $('blocker-prev').onclick=()=>{page=Math.max(0,page-1);generation++;void refresh();};$('blocker-next').onclick=()=>{page=Math.min(pages-1,page+1);generation++;void refresh();};let timer;$('blocker-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{page=0;generation++;void refresh();},250);};
 return{sync(){const next=getState().state?.shopId||null;if(shop!==next){shop=next;filter='all';page=0;generation++;signature='';for(const b of document.querySelectorAll('[data-blocker-filter]'))b.classList.toggle('selected',b.dataset.blockerFilter===filter);$('blocker-records').replaceChildren(node('div','panel empty',shop?'正在读取核验事项':'连接店铺后查看核验事项。'));}},refresh};
}
