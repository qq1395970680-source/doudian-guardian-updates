export function createRecoveries({getState,node,money,discount,time}){
 const $=id=>document.getElementById(id),list=$('recovery-records');
 let filter='verified',query='',page=0,shop,revision='',request=0,controller,searchTimer,result;
 const expanded=new Map();
 const set=(id,value)=>{const t=String(value),el=$(id);if(el.textContent!==t)el.textContent=t;};
 function reset(){controller?.abort();request++;shop=getState().shopId;revision='';page=0;result=null;expanded.clear();
  list.replaceChildren(node('div','empty','正在读取本店恢复记录'));for(const id of ['recovery-products','recovery-occurrences','recovery-skus','recovery-pending'])set(id,'—');}
 function sync(){if(shop!==getState().shopId)reset();}
 function render(data){
  result=data;page=data.page;set('recovery-products',data.counts.restoredProducts);set('recovery-occurrences',data.counts.restoredOccurrences);
  set('recovery-skus',data.counts.verifiedSkus);set('recovery-pending',data.counts.pendingOccurrences);
  set('recovery-page-label',data.total?`共 ${data.total} 条 · 第 ${page+1} / ${data.pages} 页`:'暂无记录');
  $('recovery-prev').disabled=page===0;$('recovery-next').disabled=page>=data.pages-1;
  $('recovery-feedback').hidden=true;if(revision===data.revision)return;revision=data.revision;
  const active=document.activeElement,focusKey=active?.closest('.recovery-card')?.dataset.key,wasSummary=active?.tagName==='SUMMARY';
  const fragment=document.createDocumentFragment();
  for(const r of data.records){
   const card=node('details','recovery-card'),summary=node('summary','recovery-heading');card.dataset.key=r.id;
   const mark=node('span','recovery-mark '+(r.state==='verified'?'green':r.state==='pending'?'purple':'amber'),r.state==='verified'?'✓':r.state==='pending'?'⋯':'!');
   const title=node('div','recovery-title');title.append(node('strong','',r.name),node('small','',r.productId));
   const meta=node('div','recovery-meta'),label=r.state==='verified'?'恢复成功':r.state==='pending'?(r.submitted?'结果待核实':'等待恢复'):r.submitted?'本次未恢复':'未提交';
   meta.append(node('span','badge '+(r.state==='verified'?'green':r.state==='pending'?'purple':'amber'),label),node('time','',time(r.verifiedAt||r.updatedAt)));
   summary.append(mark,title,meta,node('span','recovery-chevron','⌄'));card.append(summary);
   const context=node('div','recovery-context');context.append(node('span','',r.mode==='original'?'原折扣恢复':r.mode==='automatic-price-increase'?'按授权自动提价':'按确认价格恢复'),node('span','',`${r.skuCount} 个规格`));
   if(r.activityType)context.append(node('span','',r.activityType));
   if(r.activityType==='限量抢购')context.append(node('span','',`商品总限量 ${r.activityLimit} 件`));
   if(r.campaignId)context.append(node('span','',`活动 ${r.campaignId}`));card.append(context);
   let body;
   function details(){
    if(body)return;body=node('div','recovery-detail');
    body.append(node('p','helper',r.state==='verified'?'此记录已通过独立逐规格回读。它证明当次恢复结果，当前是否生效请查看“折扣概览”。':'以下为该次计划价格，尚不能作为恢复成功的证明。'+(r.reason?' '+r.reason:'')));
    const facts=node('div','recovery-facts');for(const [label,value] of [['创建任务',time(r.createdAt)],['记录提交',time(r.submittedAt)],['独立回读',time(r.verifiedAt)]]){const fact=node('div');fact.append(node('small','',label),node('strong','',value));facts.append(fact);}body.append(facts);
    if(r.activityType==='限量抢购')body.append(node('p','helper',`限量抢购 · 商品共用 ${r.activityLimit} 件 · ${r.durationMs/86400000} 天 · 自动续期${r.autoRenew?'开启':'关闭'}。`));
    const tableWrap=node('div','price-table-scroll'),table=node('table','recovery-skus'),head=node('thead'),tr=node('tr'),rows=node('tbody');
    for(const h of ['规格','原价','历史折后价',r.state==='verified'?'恢复折后价':'计划折后价','折扣'])tr.append(node('th','',h));head.append(tr);table.append(head,rows);tableWrap.append(table);body.append(tableWrap);
    const pager=node('div','pagination'),info=node('span'),buttons=node('div'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格');
    const key=r.id;let skuPage=Math.min(expanded.get(key)||0,Math.max(0,Math.ceil(r.skus.length/10)-1));
    const draw=()=>{const f=document.createDocumentFragment();for(const s of r.skus.slice(skuPage*10,(skuPage+1)*10)){const row=node('tr');
     const title=node('td');title.append(node('strong','',s.name||s.id),node('small','',s.id));row.append(title);
     for(const t of [money(s.baseFen),money(s.historicalSaleFen),money(s.saleFen),discount(s.discount)])row.append(node('td','',t));
     if(s.historicalSaleFen!==s.saleFen)row.classList.add('price-changed');f.append(row);}
     rows.replaceChildren(f);info.textContent=`${r.skus.length} 个规格 · ${skuPage+1} / ${Math.max(1,Math.ceil(r.skus.length/10))}`;
     prev.disabled=skuPage===0;next.disabled=(skuPage+1)*10>=r.skus.length;expanded.set(key,skuPage);};
    prev.onclick=()=>{skuPage--;draw();};next.onclick=()=>{skuPage++;draw();};buttons.append(prev,next);pager.append(info,buttons);body.append(pager);
    if(r.salePriceEvidence==='verified-base-and-discount-with-computed-sale')body.append(node('p','detail-note','折后价根据独立核对过的原价和折扣计算。'));
    if(r.skippedSkuCount)body.append(node('p','detail-note',`${r.skippedSkuCount} 个已缺失历史规格未参与本次恢复，完整历史仍保留。`));
    body.append(node('p','recovery-task-id','任务编号 '+r.taskId));card.append(body);draw();
   }
   card.ontoggle=()=>{if(card.open)details();else expanded.delete(r.id);};if(expanded.has(r.id)){card.open=true;details();}fragment.append(card);
  }
  if(!data.records.length){const empty=node('div','empty recovery-empty');empty.append(node('span','empty-check','✓'),node('strong','',query?'没有找到匹配记录':filter==='verified'?'暂时没有恢复成功记录':'暂无此类记录'),node('span','',query?'试试商品名称、商品 ID、规格或活动编号。':'程序恢复折扣并完成独立回读后，记录会自动出现在这里。'));fragment.append(empty);}
  list.replaceChildren(fragment);if(wasSummary&&focusKey)[...list.children].find(el=>el.dataset.key===focusKey)?.querySelector('summary')?.focus({preventScroll:true});
 }
 async function refresh(){sync();if(!getState().visible||document.hidden)return;controller?.abort();const currentController=new AbortController();controller=currentController;
  const seq=++request,requestShop=shop,timeout=setTimeout(()=>currentController.abort(),10000),params=new URLSearchParams({filter,q:query,page:String(page),size:'12'});
  try{const response=await fetch('/api/recoveries?'+params,{signal:currentController.signal});if(!response.ok)throw Error('恢复记录暂时读取失败');const data=await response.json();
   if(seq!==request||requestShop!==getState().shopId||data.shopId!==getState().shopId)return;render(data);
  }catch(e){if(seq===request){$('recovery-feedback').hidden=false;set('recovery-feedback','暂时无法刷新记录，正在重试。');}}
  finally{clearTimeout(timeout);}
 }
 document.querySelectorAll('[data-recovery-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.recoveryFilter;page=0;document.querySelectorAll('[data-recovery-filter]').forEach(x=>x.classList.toggle('selected',x===b));void refresh();});
 $('recovery-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{query=$('recovery-search').value;page=0;void refresh();},120);};
 $('recovery-prev').onclick=()=>{page--;void refresh();};$('recovery-next').onclick=()=>{page++;void refresh();};
 return{sync,refresh};
}
