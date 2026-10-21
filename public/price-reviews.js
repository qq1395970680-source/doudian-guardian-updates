// A read-only proposal never grants consent. The only approval path is the
// unchecked checkbox and explicit button below; prices are never sent by UI.
export function createPriceReviews({getState,post,toast,node,money,discount,time}) {
 const $=id=>document.getElementById(id),cards=new Map(),pageSize=10,skuPageSize=25;
 let shop=null,reviews=[],pageIndex=0,total=0,pages=1,loading=false,readAt=0,action=null,visibleIds='',loadVersion=0,direction='increase';
 const labels={pending:'等待确认',approved:'已确认',declined:'暂不调整',superseded:'已失效'};
 const current=()=>getState();
 const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 function reset(next){shop=next;reviews=[];pageIndex=0;total=0;pages=1;readAt=0;loadVersion++;cards.clear();visibleIds='';for(const mode of ['increase','decrease'])setText($('price-'+mode+'-count'),'—');$('price-reviews').replaceChildren(node('div','empty','正在读取价格建议'));pagination();}
 function pagination(){$('price-page-label').textContent=total?`${total} 份记录 · 第 ${pageIndex+1} / ${pages} 页`:'0 份记录';$('price-prev').disabled=loading||!!action||pageIndex===0;$('price-next').disabled=loading||!!action||pageIndex===pages-1;}
 function directionHeading(){
  for(const b of document.querySelectorAll('[data-price-direction]')){const selected=b.dataset.priceDirection===direction;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));b.disabled=!!action;}
  setText($('price-direction-title'),direction==='increase'?'需要调高的商品':direction==='decrease'?'需要调低的商品':'全部价格记录');
  setText($('price-direction-detail'),direction==='increase'?'这里只显示全部规格均提价或不变的待确认方案。展开商品核对后，可直接确认并继续守护。':direction==='decrease'?'只要有一个规格建议降价，整件商品就放在这里。混合提价也一并展示；请核对全部规格和利润后再确认。':'查看待确认、已确认、暂不调整和已失效的完整记录。确认价格不等于恢复成功，请查看独立回读结果。');
 }
 function eligible(r){const s=current();return s.online&&s.state?.shopId===r.shopId&&s.state?.connection?.shopId===r.shopId&&Date.now()-readAt<15000&&!action;}
 function updateControls(card){
  const {r}=card,expired=r.expiresAt<=Date.now(),ready=eligible(r),selected=!card.source.options||card.option?.available;
  setText(card.badge,r.requiresReconfirmation?'原确认需重新核对':r.status==='pending'&&expired?'建议已过期':r.status==='approved'&&r.approvalKind==='automatic-price-increase'?'按本店授权自动提价':labels[r.status]||'等待更新');
  if(card.checkbox){card.checkbox.disabled=!ready||expired||!selected;card.approve.disabled=!ready||expired||!selected||!card.checkbox.checked;}
  for(const button of card.optionButtons||[])button.disabled=!ready||!button.optionAvailable;
  if(card.decline)card.decline.disabled=!ready;
  if(card.recalculate)card.recalculate.disabled=!ready;
  if(card.note)setText(card.note,!current().online?'暂时离线，重新连接后才能确认。':current().state?.connection?.shopId!==r.shopId?'请先连接并核对当前店铺。':expired?'这份建议已过期，请重新核对平台要求。':!selected?'当前没有可用的不降价方案。可查看原算法方案的具体差额；程序不会默认采用降价。':`有效至 ${time(r.expiresAt)} · 确认后，后台会重新核对商品再执行。`);
 }
 async function decide(card,decision){
  const r=card.r;if(!eligible(r))return;
  if(decision==='approve'&&(!card.checkbox?.checked||r.expiresAt<=Date.now()))return;
  action=r.id;loadVersion++;for(const c of cards.values())updateControls(c);pagination();directionHeading();
  try{
   const args={shopId:r.shopId,reviewId:r.id,key:r.key,decision};
   if(decision==='approve')Object.assign(args,{confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,...(card.option?{optionId:card.option.id,optionKey:card.option.key}:{})});
   const result=await post('price-reviews/decide',args);
   if(shop!==r.shopId)return;
   reviews=reviews.map(row=>row.id===r.id?result.review:row);render();
   toast(decision==='approve'?'表内价格已确认。开启守护时，后台会重新核对后执行。':decision==='decline'?'已保留原设置，不采用这份调价建议。':'已请求重新核对；新的建议仍需你确认。');
  }catch(e){toast(e.message);readAt=0;}
  finally{action=null;loadVersion++;readAt=0;for(const c of cards.values())updateControls(c);pagination();directionHeading();void refresh();}
 }
 function buildCard(r,previous,first){
  const source=r,signature=JSON.stringify(source),options=source.options||[];
  const wanted=previous?.signature===signature?previous.selectedOptionId:null;
  const option=options.find(o=>o.id===wanted&&o.available)||(!wanted?options.find(o=>['balanced','reconfirm-rounding'].includes(o.id)&&o.available):null);
  if(options.length)r={...source,rows:option?.rows||[],ratio:option?.ratio,type:option?.activityType||source.type};
  const el=node('details','panel price-review'),summary=node('summary','price-review-heading'),title=node('div');
  el.dataset.reviewId=r.id;el.open=previous?.el.open??(first&&r.status==='pending');
  title.append(node('h2','',r.name||'商品 '+r.productId),node('p','',`${r.productId} · ${source.rows.length} 个规格${options.length?` · ${options.length} 种调整方案`:` · ${r.rows.filter(s=>s.discount!==s.previousDiscount).length} 个建议调整`}`));
  const badge=node('span','badge '+(r.status==='approved'?'green':'amber'));summary.append(title,badge);el.append(summary);
  const card={el,r,source,option,selectedOptionId:option?.id||null,optionButtons:[],badge,signature,skuPage:previous?.skuPage||0};let populated=false;
  function populate(){if(populated)return;populated=true;
   const body=node('div','price-review-body'),caption=node('p','helper','下表包含本商品全部规格。已有守护价与建议价由已核对原价 × 折扣计算；未调整的规格保持原设置。');
   body.append(caption);
   if(source.kind==='rounding-reconfirmation'){
    caption.textContent='旧确认金额因取整规则更新而失效。左列来自原确认单，右列按相同折扣向上取分；旧确认金额与完整历史均保留。必须重新确认后才能执行。';
    const duration=source.durationMs,seconds=Number.isSafeInteger(duration)?duration/1000:null;
    body.append(node('p','detail-note',`沿用活动：${source.type}${seconds!=null?' · 时长 '+Math.floor(seconds/86400)+' 天 '+Math.floor(seconds%86400/3600)+' 时 '+Math.floor(seconds%3600/60)+' 分 '+seconds%60+' 秒':''}${source.activityLimit!=null?' · 总限量 '+source.activityLimit+' 件':''}。`));
   }
   if(options.length){
    const activities=node('div','price-activity-comparison');
    for(const type of source.kind==='rounding-reconfirmation'?[source.type]:['限量抢购','限时抢购']){
     const candidates=options.filter(o=>o.activityType===type),safe=candidates.filter(o=>o.available&&o.rows.every(s=>s.saleFen>=s.previousFen)),unverified=candidates.some(o=>o.validationStatus==='unverified');
     const block=node('div','price-activity-status');
     block.append(node('strong','',type),node('p','helper',unverified?'待目标活动实时核验；切换类型不代表跳过价格限制。':safe.length?'有不降价候选方案，仍需目标活动实时校验。':'当前已读限制下没有不降价方案；请查看各方案的具体原因。'));
     if(type===source.type){
      const reasons=[...new Set(source.rows.flatMap(row=>row.evidence||[]))];
      if(reasons.length)block.append(node('p','helper','已读限制：'+reasons.join('；')));
     }
     const attempt=source.activityChecks?.find(c=>c.type===type);
     if(attempt)block.append(node('p','helper',`最近尝试：${time(attempt.at)} · ${attempt.reason}`));
     activities.append(block);
    }
    body.append(activities);
    const choices=node('div','price-options');
    for(const candidate of options){
     const button=node('button','price-option'+(candidate.id===card.selectedOptionId?' selected':''));
     button.type='button';button.dataset.priceOption=candidate.id;button.optionAvailable=candidate.available;
     button.setAttribute('aria-pressed',String(candidate.id===card.selectedOptionId));
     button.append(node('strong','',candidate.label),node('span','',candidate.description));
     if(candidate.available){
      const up=candidate.rows.filter(s=>s.saleFen>s.previousFen).length,down=candidate.rows.filter(s=>s.saleFen<s.previousFen).length;
      button.append(node('small','',`调高 ${up} 个 · 调低 ${down} 个${candidate.sameAs?' · 价格与'+candidate.sameAs+'相同':''}`));
      if(candidate.validationStatus==='unverified')button.append(node('small','',candidate.reason));
     }else button.append(node('small','price-option-unavailable','无可行方案：'+candidate.reason));
     button.onclick=()=>{
      if(action||!candidate.available||!eligible(source))return;
      const next=buildCard(source,{...card,selectedOptionId:candidate.id,checkbox:null,skuPage:0},first);
      cards.set(source.id,next);card.el.replaceWith(next.el);
     };
     choices.append(button);card.optionButtons.push(button);
    }
    body.append(choices,node('p','helper',option?`当前查看：${option.label}。切换方案后需要重新勾选确认。`:'默认不采用降价；当前没有可用的不降价方案。选择“原算法方案”可以查看其价格，但不会自动同意。'));
   }
   if(r.selectedOption)body.append(node('p','detail-note','已确认方案：'+r.selectedOption.label));
   if(options.length&&!option){
    const note=node('p','helper'),recalculate=node('button','text-button','重新核对'),decline=node('button','button secondary','暂不调整');
    Object.assign(card,{note,recalculate,decline});
    recalculate.onclick=()=>void decide(card,'recalculate');decline.onclick=()=>void decide(card,'decline');
    body.append(note,recalculate,decline);el.append(body);updateControls(card);return;
   }
   const raised=r.rows.filter(s=>s.saleFen>s.previousFen),lowered=r.rows.filter(s=>s.saleFen<s.previousFen);
   const changes=node('div','price-change-summary');
   changes.append(node('span','badge blue',`调高 ${raised.length} 个规格`),node('span','badge '+(lowered.length?'amber':'neutral'),`调低 ${lowered.length} 个规格`),node('span','badge neutral',`不变 ${r.rows.length-raised.length-lowered.length} 个规格`));
   body.append(changes);
   if(lowered.length)body.append(node('p','price-lower-warning',`包含降价：单个规格最多降低 ${money(Math.max(...lowered.map(s=>s.previousFen-s.saleFen)))}。请核对下表每个规格；此操作不会默认同意其他商品。`));
   if(r.kind==='sku-price-ratio'&&r.ratio){
    const rule=r.ratio,limit=rule.numerator/rule.denominator;
    body.append(node('p','detail-note',`平台要求最高规格价不超过最低价的 ${limit} 倍。已有价格倍率 ${(rule.previousMaxFen/rule.previousMinFen).toFixed(2)}，本表建议倍率 ${(rule.proposedMaxFen/rule.proposedMinFen).toFixed(2)}。`));
    body.append(node('p','helper','依据本轮平台剔除明细和当前规格计算，优先选择不降价方案，再减少各规格调价金额的总和（各规格等权）。倍率推算不属于自动提价授权；确认后仍需核对平台其他价格要求。'));
    if(rule.lowerSkuCount>0)body.append(node('p','detail-note',`本表包含 ${rule.lowerSkuCount} 个规格降价。若不接受降价，请勿确认；程序不会自动切换到这一方案。`));
   }
   if(r.skippedSkuIds?.length)body.append(node('p','detail-note',`${r.skippedSkuIds.length} 个历史规格当前缺失，本次未包含；完整历史仍保留。`));
   const scroll=node('div','price-table-scroll'),table=node('table','price-table'),head=node('thead'),tr=node('tr'),tbody=node('tbody');
   for(const h of ['规格 / 原价','已有守护价','建议守护价','价格变化',r.ratio?'平台倍率依据':'平台依据'])tr.append(node('th','',h));head.append(tr);table.append(head,tbody);scroll.append(table);body.append(scroll);
   const pagination=node('div','pagination sku-pagination'),label=node('span'),buttons=node('div'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格');
   buttons.append(prev,next);pagination.append(label,buttons);body.append(pagination);
   const drawRows=()=>{const pages=Math.max(1,Math.ceil(r.rows.length/skuPageSize));card.skuPage=Math.min(card.skuPage,pages-1);const fragment=document.createDocumentFragment();
    for(const row of r.rows.slice(card.skuPage*skuPageSize,(card.skuPage+1)*skuPageSize)){
     const tr=node('tr',row.discount!==row.previousDiscount?'price-changed':''),name=node('td');name.append(node('strong','',row.name||row.id),node('small','',money(row.baseFen)));
     const before=node('td'),after=node('td');before.append(node('strong','',money(row.previousFen)),node('small','',discount(row.previousDiscount)));after.append(node('strong','',money(row.saleFen)),node('small','',discount(row.discount)));
     const amount=row.saleFen-row.previousFen,percent=row.previousFen>0?` / ${(Math.abs(amount)/row.previousFen*100).toFixed(2)}%`:'';
     const change=amount!==0?`${amount>0?'提高':'降低'} ${money(Math.abs(amount))}${percent}`:row.discount!==row.previousDiscount?'金额不变，折扣档位调整':'不变';
     tr.append(name,before,after,node('td','',change),node('td','price-evidence',row.evidence.join('；')||'保持原设置'));fragment.append(tr);
    }
    tbody.replaceChildren(fragment);label.textContent=`全部 ${r.rows.length} 个规格 · 第 ${card.skuPage+1} / ${pages} 页`;prev.disabled=card.skuPage===0;next.disabled=card.skuPage===pages-1;
   };prev.onclick=()=>{card.skuPage--;drawRows();};next.onclick=()=>{card.skuPage++;drawRows();};drawRows();
   if(r.status==='pending'){
    const consent=node('label','check-label price-consent'),checkbox=node('input');checkbox.type='checkbox';
    // Never preserve consent across a changed/expired proposal or account.
    checkbox.checked=previous?.signature===card.signature&&previous.selectedOptionId===card.selectedOptionId&&previous.checkbox?.checked===true;
    consent.append(checkbox,node('span','',`我已核对本商品全部 ${r.rows.length} 个规格，同意${card.option?'所选「'+card.option.label+'」及活动类型「'+r.type+'」、':''}表内价格及对应的低价风险提示，并按这些确切价格继续守护。`));body.append(consent);
    const actions=node('div','price-review-actions'),approve=node('button','button primary','确认表内价格并继续守护'),decline=node('button','button secondary','暂不调整');
    actions.append(approve,decline);body.append(actions);Object.assign(card,{checkbox,approve,decline});
    checkbox.onchange=()=>updateControls(card);approve.onclick=()=>void decide(card,'approve');decline.onclick=()=>void decide(card,'decline');
   }
   if(['pending','declined'].includes(r.status)||r.requiresReconfirmation){
    const row=node('div','price-review-foot'),note=node('p','helper'),recalculate=node('button','text-button','重新核对');row.append(note,recalculate);body.append(row);Object.assign(card,{note,recalculate});recalculate.onclick=()=>void decide(card,'recalculate');
   }else body.append(node('p','helper',r.status==='approved'?(r.approvalKind==='automatic-price-increase'?'本表由你开启的本店自动提价规则生成，已记录确切价格；未采用任何进一步降价。':'已记录你确认的本表确切价格。')+'是否恢复成功，请以商品折扣及独立回读结果为准。':(r.supersededReason||'已请求重新核对')+'；这份建议不会用于执行。'));
   el.append(body);updateControls(card);
  }
  el.addEventListener('toggle',()=>{if(el.open)populate();});if(el.open)populate();updateControls(card);return card;
 }
 function render(){
  const rows=reviews;let replaced=false;
  for(const [i,r] of rows.entries()){const previous=cards.get(r.id);if(previous?.signature!==JSON.stringify(r)){const c=buildCard(r,previous,i===0);cards.set(r.id,c);if(previous?.el.isConnected)previous.el.replaceWith(c.el);else replaced=true;}}
  const ids=JSON.stringify(rows.map(r=>r.id));if(ids!==visibleIds||replaced){$('price-reviews').replaceChildren(...rows.map(r=>cards.get(r.id).el));visibleIds=ids;}
  if(!rows.length)$('price-reviews').replaceChildren(node('div','empty',shop?(direction==='all'?'当前没有价格确认记录。':direction==='increase'?'当前没有待确认的提价方案。':'当前没有待确认的降价方案。'):'连接店铺后，这里会显示需要你确认的价格建议。'));
  for(const [id,c] of cards){if(!reviews.some(r=>r.id===id))cards.delete(id);else updateControls(c);}
  pagination();
 }
 function changePage(delta){if(loading||action)return;pageIndex=Math.max(0,Math.min(pages-1,pageIndex+delta));readAt=0;loadVersion++;for(const c of cards.values())updateControls(c);void refresh();}
 $('price-prev').onclick=()=>changePage(-1);$('price-next').onclick=()=>changePage(1);
 for(const button of document.querySelectorAll('[data-price-direction]'))button.onclick=()=>{
  if(action||direction===button.dataset.priceDirection)return;
  direction=button.dataset.priceDirection;reset(shop);directionHeading();void refresh();
 };
 directionHeading();
 async function refresh(){if(loading||action)return;loading=true;pagination();const expectedShop=shop,expectedVersion=loadVersion;
   try{const response=await fetch(`/api/price-reviews?page=${pageIndex}&size=${pageSize}&direction=${direction}`,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('价格建议暂时无法读取');const result=await response.json();
    if(shop!==expectedShop||result.shopId!==shop||loadVersion!==expectedVersion||action)return;
    if(!Array.isArray(result.reviews)||result.reviews.length>pageSize||!Number.isSafeInteger(result.total)||!Number.isSafeInteger(result.pages)||!Number.isSafeInteger(result.page))throw Error('价格建议分页待重新读取');
    reviews=result.reviews;total=result.total;pages=result.pages;pageIndex=result.page;readAt=Date.now();
    for(const mode of ['increase','decrease'])setText($('price-'+mode+'-count'),String(result.directionCounts?.[mode]??0));
    render();
   }catch{readAt=0;if(!reviews.length)$('price-reviews').replaceChildren(node('div','empty','价格建议暂时无法读取，正在重新连接。'));for(const c of cards.values())updateControls(c);}
   finally{loading=false;pagination();if(loadVersion!==expectedVersion&&!action)void refresh();}
  }
 return {
  sync(){if(shop!==current().state?.shopId)reset(current().state?.shopId||null);for(const c of cards.values())updateControls(c);},
  refresh
 };
}
