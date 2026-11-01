import {renderActivityPrices} from './activity-prices.js';
// Shared exact-price UI. A read or preview never approves a price.
export function createPriceReviewCards({getState,post,toast,node,money,discount,time,getReadAt,getAction,onAction,onReview,onSettled,replaceCard,context='prices',endpoint='price-reviews/decide',isCurrentCard=()=>true}){
 const current=()=>getState();
 const labels={pending:'等待确认',approved:'已确认',declined:'暂不调整',superseded:'已失效'};
 const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 const skuPageSize=25;
 function eligible(r){const s=current();return s.online&&s.state?.shopId===r.shopId&&s.state?.connection?.shopId===r.shopId&&Date.now()-getReadAt()<15000&&!getAction();}
 function updateControls(card){
  card.manualDirty=card.option?.id==='manual-discount'&&!!card.manualValues&&card.option.discounts.some(row=>Number(card.manualValues.get(row.id))*10!==row.discount);
  const {r}=card,expired=r.expiresAt<=Date.now(),ready=eligible(r),selected=(!card.source.options||card.option?.available)&&!(card.manualDirty&&card.option?.id==='manual-discount');
  setText(card.badge,r.requiresReconfirmation?'原确认需重新核对':r.status==='pending'&&expired?'建议已过期':r.status==='approved'&&r.approvalKind==='original-price-continuity'?'按原价规则沿用确认':r.status==='approved'&&r.approvalKind==='automatic-price-increase'?'按本店授权自动提价':labels[r.status]||'等待更新');
  if(card.checkbox){card.checkbox.disabled=!ready||expired||!selected;card.approve.disabled=!ready||expired||!selected||!card.checkbox.checked;}
  for(const button of card.optionButtons||[])button.disabled=!ready||!button.optionAvailable;
  for(const button of card.el.querySelectorAll('[data-activity-price-choice]'))button.disabled=!ready;
  if(card.decline)card.decline.disabled=!ready;
  if(card.recalculate)card.recalculate.disabled=!ready;
  if(card.note)setText(card.note,!current().online?'暂时离线，重新连接后才能确认。':current().state?.connection?.shopId!==r.shopId?'请先连接并核对当前店铺。':expired?'这份建议已过期，请重新核对平台要求。':card.manualDirty&&card.option?.id==='manual-discount'?'折扣输入已变化，请先重新预览价格。':!selected?'当前没有可用的不降价方案。可查看原算法方案的具体差额；程序不会默认采用降价。':`有效至 ${time(r.expiresAt)} · 确认后，后台会重新核对商品再执行。`);
 }
 async function decide(card,decision){
  const r=card.r;if(!eligible(r))return;
  if(decision==='approve'&&(!card.checkbox?.checked||r.expiresAt<=Date.now()))return;
  onAction(r.id);
  try{
   const args={shopId:r.shopId,reviewId:r.id,key:r.key,decision};
   if(decision==='approve')Object.assign(args,{confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true,...(card.source.kind==='limited-rebuild'?{confirmRebuild:true}:{}),...(card.option?{optionId:card.option.id,optionKey:card.option.key}:{})});
   if(context==='recovery-blockers'&&decision==='approve')args.acceptBlockedPriceChange=true;
   if(card.option?.id==='manual-discount'){args.manualDiscounts=card.option.discounts;args.manualActivityType=card.option.activityType;}
   const result=await post(endpoint,args);
   if(current().state?.shopId!==r.shopId)return;
   onReview(result.review);
   toast(decision==='approve'?'已确认并加入优先恢复队列，当前读取收尾后立即核验恢复。':decision==='decline'?'已保留原设置，不采用这份调价建议。':'已请求重新核对；新的建议仍需你确认。');
  }catch(e){toast(e.message);}
  finally{onAction(null);onSettled();}
 }
 function buildCard(r,previous,first){
  const source=r,signature=JSON.stringify(source),options=source.options||[];
  const wanted=previous?.signature===signature?previous.selectedOptionId:null;
  const option=options.find(o=>o.id===wanted&&o.available)||(!wanted?options.find(o=>['balanced','reconfirm-rounding','rebuild-confirmed'].includes(o.id)&&o.available):null);
  if(options.length)r={...source,rows:option?.rows||[],ratio:option?.ratio,type:option?.activityType||source.type};
  const el=node('details','panel price-review'),summary=node('summary','price-review-heading'),title=node('div');
  el.dataset.reviewId=r.id;el.open=previous?.el.open??(first&&r.status==='pending');
  title.append(node('h2','',r.name||'商品 '+r.productId),node('p','',`${r.productId} · ${source.rows.length} 个规格${options.length?` · ${options.length} 种调整方案`:` · ${r.rows.filter(s=>s.discount!==s.previousDiscount).length} 个建议调整`}`));
  const badge=node('span','badge '+(r.status==='approved'?'green':'amber'));summary.append(title,badge);el.append(summary);
  const card={el,r,source,option,selectedOptionId:option?.id||null,optionButtons:[],badge,signature,skuPage:previous?.skuPage||0};let populated=false;
  function populate(){if(populated)return;populated=true;
   const body=node('div','price-review-body'),caption=node('p','helper','下表包含本商品全部规格。已有守护价与建议价由已核对原价 × 折扣计算；未调整的规格保持原设置。');
   body.append(caption);
   if(source.kind==='limited-rebuild'){
    const target=option?.rebuildTarget||source.rebuildTarget,seconds=target.durationMs/1000;
    caption.textContent='当前完整活动列表已核对，商品没有有效活动；原活动的退出性质尚未证实。下表保持已有守护价，确认后按所列规则重新创建，不把缺失当作异常剔除。';
    body.append(node('p','price-lower-warning',`重新创建：${target.type} · ${Math.floor(seconds/86400)}天 ${Math.floor(seconds%86400/3600)}时 ${Math.floor(seconds%3600/60)}分 ${seconds%60}秒 · ${target.activityLimit!=null?'重新提供总限量 '+target.activityLimit+' 件':'不限量'} · 不限购、不预热 · ${target.rules.orderMinutes}分钟取消订单。`));
    body.append(node('p','detail-note',`原活动：${source.rebuildSource.referenceCampaignId} · ${source.rebuildSource.status||'未找到'}；${source.sourceDetail?.nextAction||'退出原因尚未完整证明'}。`));
   }
   if(source.kind==='history-reconfirmation'){caption.textContent='历史来源已变化。左侧为本次保存的历史价格，右侧为旧确认目标；须重新确认整件商品的确切价格和活动类型。旧批准与原历史完整保留。';body.append(node('p','detail-note',`活动方案：${source.campaignTarget.type}；确认后仍需重新核验平台当前限制。`));}
   if(source.kind==='rounding-reconfirmation'){
    caption.textContent='旧确认金额因取整规则更新而失效。左列来自原确认单，右列按相同折扣向上取分；旧确认金额与完整历史均保留。必须重新确认后才能执行。';
    const duration=source.durationMs,seconds=Number.isSafeInteger(duration)?duration/1000:null;
    body.append(node('p','detail-note',`沿用活动：${source.type}${seconds!=null?' · 时长 '+Math.floor(seconds/86400)+' 天 '+Math.floor(seconds%86400/3600)+' 时 '+Math.floor(seconds%3600/60)+' 分 '+seconds%60+' 秒':''}${source.activityLimit!=null?' · 总限量 '+source.activityLimit+' 件':''}。`));
   }
   if(options.length){
    if(source.activityComparison)body.append(renderActivityPrices({comparison:source.activityComparison,node,money,discount,time,selectOption(id){
     const candidate=options.find(o=>o.id===id);if(getAction()||!candidate?.available||!eligible(source))return;
     const next=buildCard(source,{...card,selectedOptionId:id,checkbox:null,skuPage:0},first);replaceCard(source.id,next);card.el.replaceWith(next.el);
    },disabled:!eligible(source)}));
    const activities=node('div','price-activity-comparison');activities.hidden=!!source.activityComparison;
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
    if(!source.activityComparison)body.append(activities);
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
      if(getAction()||!candidate.available||!eligible(source))return;
      const next=buildCard(source,{...card,selectedOptionId:candidate.id,checkbox:null,skuPage:0},first);
      replaceCard(source.id,next);card.el.replaceWith(next.el);
     };
     choices.append(button);card.optionButtons.push(button);
    }
    body.append(choices,node('p','helper',option?`当前查看：${option.label}。切换方案后需要重新勾选确认。`:'默认不采用降价；当前没有可用的不降价方案。选择“原算法方案”可以查看其价格，但不会自动同意。'));
   }
   if(r.selectedOption)body.append(node('p','detail-note','已确认方案：'+r.selectedOption.label));
   if(context==='recovery-blockers'&&source.manualEditable&&(!source.manualTypes||source.manualTypes.includes(option?.activityType||source.type))){
    const manual=node('details','manual-price-editor'),heading=node('summary','','自定义各规格折扣');manual.append(heading,node('p','helper','当前编辑活动：'+(option?.activityType||source.type)),node('p','helper','输入 1 至 9.5 折，每档 0.1 折；金额按当前原价向上取分。预览只计算价格，确认后才加入恢复队列。'));
    const values=new Map((previous?.option?.activityType===option?.activityType&&previous?.manualValues||(option?.rows||source.rows).map(row=>[row.id,String(row.discount/10)]))),list=node('div','manual-price-rows'),pager=node('div','pagination'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格'),label=node('span');let manualPage=0;
    card.manualValues=values;const draw=()=>{const count=Math.max(1,Math.ceil(source.rows.length/25));manualPage=Math.min(manualPage,count-1);list.replaceChildren(...source.rows.slice(manualPage*25,(manualPage+1)*25).map(row=>{const field=node('label','setting-row'),input=node('input');input.type='number';input.min='1';input.max='9.5';input.step='0.1';input.value=values.get(row.id);input.setAttribute('aria-label',row.name+'折扣');input.dataset.manualSku=row.id;input.oninput=()=>{values.set(row.id,input.value);card.manualDirty=true;if(card.checkbox){card.checkbox.checked=false;updateControls(card);}};field.append(node('span','',row.name+' · 原价 '+money(row.baseFen)),input);return field;}));label.textContent='全部 '+source.rows.length+' 个规格 · 第 '+(manualPage+1)+' / '+count+' 页';prev.disabled=manualPage===0;next.disabled=manualPage===count-1;};prev.onclick=()=>{manualPage--;draw();};next.onclick=()=>{manualPage++;draw();};pager.append(label,prev,next);draw();
    const preview=node('button','button secondary','预览自定义价格');preview.onclick=async()=>{if(!eligible(source))return;preview.disabled=true;try{const discounts=source.rows.map(row=>({id:row.id,discount:Number(values.get(row.id))*10}));const result=await post('recovery-blockers/prices/preview',{shopId:source.shopId,reviewId:source.id,key:source.key,activityType:option?.activityType||source.type,discounts});if(current().state?.shopId!==source.shopId||!isCurrentCard(card))return;const customOption=result.option,nextSource={...source,options:[...(source.options||[]).filter(o=>o.id!=='manual-discount'),customOption]};const next=buildCard(nextSource,{...card,signature:JSON.stringify(nextSource),selectedOptionId:customOption.id,checkbox:null},first);replaceCard(source.id,next);card.el.replaceWith(next.el);}catch(e){toast(e.message);}finally{preview.disabled=false;}};manual.append(list,pager,preview);body.append(manual);
   }
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
    consent.append(checkbox,node('span','',`${context==='recovery-blockers'?'本次只调整这件商品，整店仍按原折扣价自动恢复。':''}我已核对本商品全部 ${r.rows.length} 个规格，同意${card.option?'所选「'+card.option.label+'」及活动类型「'+r.type+'」、':''}表内价格及对应的低价风险提示，并按这些确切价格继续守护。${source.kind==='limited-rebuild'?'我理解原活动退出原因尚未证实，明确同意按上方确切时长及限量额度重新创建活动。':''}`));body.append(consent);
    const actions=node('div','price-review-actions'),approve=node('button','button primary',source.kind==='limited-rebuild'?'确认重新创建并继续守护':'确认表内价格并继续守护'),decline=node('button','button secondary','暂不调整');
    actions.append(approve,decline);body.append(actions);Object.assign(card,{checkbox,approve,decline});
    checkbox.onchange=()=>updateControls(card);approve.onclick=()=>void decide(card,'approve');decline.onclick=()=>void decide(card,'decline');
   }
   if(['pending','declined'].includes(r.status)||r.requiresReconfirmation){
    const row=node('div','price-review-foot'),note=node('p','helper'),recalculate=node('button','text-button','重新核对');row.append(note,recalculate);body.append(row);Object.assign(card,{note,recalculate});recalculate.onclick=()=>void decide(card,'recalculate');
   }else body.append(node('p','helper',r.status==='approved'?(r.approvalKind==='original-price-continuity'?'本表按已开启的本店原价恢复规则沿用旧确认的确切价格，未采用新价格。':r.approvalKind==='automatic-price-increase'?'本表由你开启的本店自动提价规则生成，已记录确切价格；未采用任何进一步降价。':'已记录你确认的本表确切价格。')+'是否恢复成功，请以商品折扣及独立回读结果为准。':(r.supersededReason||'已请求重新核对')+'；这份建议不会用于执行。'));
   el.append(body);updateControls(card);
  }
  el.addEventListener('toggle',()=>{if(el.open)populate();});if(el.open)populate();updateControls(card);return card;
 }

 return{buildCard,updateControls};
}
