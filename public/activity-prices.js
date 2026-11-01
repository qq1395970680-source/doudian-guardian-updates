export function renderActivityPrices({comparison=[],node,money,discount,time,selectOption=null,disabled=false}){
 const wrap=node('section','activity-price-comparison');
 const states={rejected:'已有明确拒绝记录',historical:'旧价格目标的拒绝记录',verified:'该次已回读',unverified:'尚未证实本方案失败','check-blocked':'读取或校验受阻',pending:'结果待核实'};
 for(const scheme of comparison){
  const card=node('article','activity-price-card');card.dataset.activityPriceType=scheme.type;
  const head=node('div','button-row');head.append(node('h3','',scheme.type),node('span','badge '+(scheme.rejectionState==='rejected'?'amber':'neutral'),states[scheme.rejectionState]||'待核验'));
  card.append(head,node('p','reason','受阻原因：'+String(scheme.reason||'尚未取得明确原因').replace(/^[A-Z_]+:\s*/,'')));
  if(scheme.rejectedAt)card.append(node('small','helper','记录时间：'+time(scheme.rejectedAt)));
  card.append(node('p','helper',scheme.guidance));
  if(scheme.campaignTarget){const t=scheme.campaignTarget,hours=t.durationMs/3600000;card.append(node('p','detail-note',`选择后活动规则：${hours} 小时 · ${t.activityLimit!=null?'总限量 '+t.activityLimit+' 件':'不限量'} · 不限购、不预热 · ${t.rules.orderMinutes} 分钟取消订单${t.rules.autoRenew?' · 自动续期':''}。`));}
  if(scheme.ratio)card.append(node('p','detail-note','本类型已读要求：最高规格价不超过最低规格价的 '+(scheme.ratio.numerator/scheme.ratio.denominator)+' 倍。'));
  for(const reason of scheme.unavailableReasons||[])card.append(node('p','reason','不可用原因：'+reason));
  if(scheme.rows?.length){
   card.append(node('p','detail-note',scheme.referenceOnly?'原折扣待核验参考，尚未得到调价结论。':`如何调整：调高 ${scheme.raised} 个规格，调低 ${scheme.lowered} 个规格；未列为调整的规格保持表内价格。`));
   const scroll=node('div','price-table-scroll'),table=node('table','price-table activity-price-table'),head=node('thead'),tr=node('tr'),body=node('tbody');
   for(const label of ['规格','已有价','本方案参考价','调整 / 约束'])tr.append(node('th','',label));head.append(tr);table.append(head,body);scroll.append(table);card.append(scroll);
   let page=0;const size=10,pages=Math.max(1,Math.ceil(scheme.rows.length/size)),pager=node('div','pagination'),label=node('span'),prev=node('button','button small secondary','上一页'),next=node('button','button small secondary','下一页');
   const draw=()=>{body.replaceChildren(...scheme.rows.slice(page*size,(page+1)*size).map(row=>{
    const tr=node('tr'),name=node('td','',row.name||row.id),before=node('td','',money(row.previousFen)),after=node('td');after.append(node('strong','',money(row.saleFen)),node('small','',discount(row.discount)));
    const amount=row.saleFen-row.previousFen,detail=node('td','',scheme.referenceOnly?'待本方案实时核验':amount?`${amount>0?'调高':'调低'} ${money(Math.abs(amount))}`:'保持不变');
    const b=row.bounds||{},limits=[];if(b.minFen!=null)limits.push('不低于 '+money(b.minFen));if(b.maxFen!=null)limits.push('不高于 '+money(b.maxFen));if(b.minDiscount!=null)limits.push('折扣不低于 '+discount(b.minDiscount));if(b.maxDiscount!=null)limits.push('折扣不高于 '+discount(b.maxDiscount));
    if(limits.length)detail.append(node('small','',limits.join('；')));if(row.evidence?.length)detail.append(node('small','',row.evidence.join('；')));
    tr.append(name,before,after,detail);return tr;
   }));label.textContent=`全部 ${scheme.rows.length} 个规格 · 第 ${page+1} / ${pages} 页`;prev.disabled=page===0;next.disabled=page===pages-1;};prev.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};pager.append(label,prev,next);draw();card.append(pager);
  }
  if(selectOption&&scheme.optionId){const choose=node('button','button secondary',scheme.referenceOnly?'选择原折扣，核验'+scheme.type:'选择'+scheme.type+'价格方案');choose.dataset.activityPriceChoice=scheme.optionId;choose.disabled=disabled;choose.onclick=()=>selectOption(scheme.optionId);card.append(choose);}
  wrap.append(card);
 }
 return wrap;
}
