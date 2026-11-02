import {renderActivityPrices} from './activity-prices.js';

// The shared drawer has one exact-price table. Only explicit consent approves it.
export function createPriceReviewCards({getState,post,toast,node,money,discount,time,getReadAt,getAction,onAction,onReview,onSettled,replaceCard,context='prices',endpoint='price-reviews/decide',isCurrentCard=()=>true}){
 const labels={pending:'等待确认',approved:'已确认价格',declined:'暂不调整',superseded:'历史记录'};
 const eligible=r=>{const s=getState();return s.online&&s.state?.shopId===r.shopId&&s.state?.connection?.shopId===r.shopId&&Date.now()-getReadAt()<15000&&!getAction();};
 const live=r=>r.status==='pending'&&r.expiresAt>Date.now()&&!r.readOnly;
 const optionName=o=>o.id==='original'?'按平台要求调整':o.id==='raise-low'?'优先提高低价规格':o.id==='balanced'?'优先保持价格不降低':o.label;
 function updateControls(card){
  const ready=eligible(card.source),expired=card.source.status==='pending'&&card.source.expiresAt<=Date.now();
  card.manualDirty=card.manualMode&&card.rows.some(row=>Number(card.manualValues.get(row.id))*10!==row.discount);
  const selected=(!card.source.options||card.option?.available)&&!card.manualDirty;
  card.badge.textContent=expired?'等待重新核对':labels[card.source.status]||'价格记录';
  if(card.checkbox){card.checkbox.disabled=!ready||!live(card.source)||!selected;card.approve.disabled=card.checkbox.disabled||!card.checkbox.checked;}
  for(const el of card.el.querySelectorAll('[data-activity-price-choice]'))el.disabled=!ready||!live(card.source);
  if(card.strategy)card.strategy.disabled=!ready||!live(card.source);
  if(card.edit)card.edit.disabled=!ready||!live(card.source);
  if(card.preview)card.preview.disabled=!ready||!live(card.source)||!card.manualDirty;
  if(card.decline)card.decline.disabled=!ready;
  if(card.recalculate)card.recalculate.disabled=!ready;
  for(const input of card.el.querySelectorAll('[data-manual-sku]'))input.disabled=!ready||!live(card.source);
  for(const price of card.el.querySelectorAll('[data-target-price]')){const row=card.rows.find(r=>r.id===price.dataset.targetPrice),dirty=card.manualMode&&Number(card.manualValues.get(row.id))*10!==row.discount;price.textContent=dirty?'待预览':money(row.saleFen);}
  if(card.note)card.note.textContent=!getState().online?'连接恢复后可继续核对。':getState().state?.connection?.shopId!==card.source.shopId?'请先连接当前店铺。':expired?'请重新核对平台要求。':card.manualDirty?'折扣已修改，请先预览新的确切价格。':!selected?'当前没有已选的可用方案，请选择活动或重新核对。':live(card.source)?'确认后先重新核验平台要求，再恢复并独立回读。':'此记录保留了当时确认的价格，实际恢复结果请查看恢复记录。';
 }
 async function decide(card,decision){
  const r=card.source;if(!eligible(r))return;if(decision==='approve'&&(!live(r)||card.manualDirty||!card.checkbox?.checked||!card.rows.length))return;onAction(r.id);
  try{const args={shopId:r.shopId,reviewId:r.id,key:r.key,decision};
   if(decision==='approve')Object.assign(args,{acceptBlockedPriceChange:true,acceptPriceAndRisk:true,confirmedSkuIds:card.rows.map(row=>row.id),...(r.kind==='limited-rebuild'?{confirmRebuild:true}:{}),...(card.option?{optionId:card.option.id,optionKey:card.option.key}:{})});
   if(card.option?.id==='manual-discount')Object.assign(args,{manualDiscounts:card.option.discounts,manualActivityType:card.option.activityType});
   const result=await post(endpoint,args);if(getState().state?.shopId!==r.shopId)return;onReview(result.review);toast(decision==='approve'?'价格已确认，后台将自动核验恢复。进度可在恢复受阻和恢复记录查看。':decision==='decline'?'已保留当前价格，暂不采用这份方案。':'已请求重新核对，取得有效依据后自动更新。');
  }catch(error){toast(error.message);}finally{onAction(null);onSettled();}
 }
 function buildCard(source,previous,first){
  const signature=JSON.stringify(source),same=previous?.signature===signature,options=source.options||[];
  const selected=options.find(o=>o.id===(same?previous.selectedOptionId:null)&&o.available)||options.find(o=>o.id==='balanced'&&o.available)||options.find(o=>o.available&&o.activityType===source.type)||options.find(o=>o.available)||null;
  const rows=options.length?(selected?.rows||[]):source.rows||[],type=selected?.activityType||source.type;
  const el=node('article','panel price-review'),heading=node('div','price-review-heading'),title=node('div');el.dataset.reviewId=source.id;
  title.append(node('h2','',source.name||'商品 '+source.productId),node('p','helper',`${rows.length||source.rows.length} 个规格 · ${type||'价格记录'}`));const badge=node('span','badge '+(source.status==='approved'?'green':'amber'));heading.append(title,badge);el.append(heading);
  const card={el,source,r:source,rows,option:selected,selectedOptionId:selected?.id||null,signature,badge,skuPage:same?previous.skuPage:0,manualMode:same&&previous?.manualMode===true,manualValues:new Map(same&&previous?.manualValues||rows.map(row=>[row.id,String(row.discount/10)]))};
  const body=node('div','price-review-body');el.append(body);
  const choose=id=>{const option=options.find(o=>o.id===id);if(!eligible(source)||!live(source)||!option?.available)return;const next=buildCard(source,{...card,signature,selectedOptionId:id,manualMode:false,manualValues:null,checkbox:null,skuPage:0},first);replaceCard(source.id,next);card.el.replaceWith(next.el);};
  if(live(source)&&source.activityComparison?.length)body.append(renderActivityPrices({comparison:source.activityComparison,selectedType:type,node,money,discount,time,selectOption:choose,disabled:!eligible(source)}));
  if(options.length){const group=node('div','price-strategy-row'),label=node('label','helper','调整方案'),select=node('select','price-strategy-select');select.setAttribute('aria-label','选择价格调整方案');for(const option of options.filter(o=>o.activityType===type)){const entry=node('option','',optionName(option)+(option.available?'':'（当前不可用）'));entry.value=option.id;entry.disabled=!option.available;entry.selected=option.id===selected?.id;select.append(entry);}if(!selected){const empty=node('option','','选择活动后查看可用方案');empty.value='';empty.selected=true;select.prepend(empty);}select.onchange=()=>choose(select.value);label.append(select);group.append(label);body.append(group);card.strategy=select;if(selected?.description)body.append(node('p','helper',selected.validationStatus==='unverified'?'此活动的价格要求仍待实时核验。下表是原折扣参考，确认不代表一定恢复成功。':selected.description));}
  if(source.kind==='history-reconfirmation')body.append(node('p','price-lower-warning','历史来源已变化。请重新核对当前规格与旧确认目标，原批准记录完整保留。'));
  if(source.kind==='rounding-reconfirmation')body.append(node('p','price-lower-warning','取整规则已更新。下表保留原折扣并列出新的确切金额，需要重新确认。'));
  const target=selected?.rebuildTarget||selected?.campaignTarget||source.rebuildTarget||source.campaignTarget;
  if(target){const hours=target.durationMs/3600000;body.append(node('p','detail-note',`活动规则：${target.type} · ${Number.isFinite(hours)?hours+' 小时 · ':''}${target.activityLimit!=null?'总限量 '+target.activityLimit+' 件':'不限量'} · 不限购、不预热 · ${target.rules.orderMinutes} 分钟取消订单${target.rules.autoRenew?' · 自动续期':''}。`));}
  if(source.kind==='limited-rebuild')body.append(node('p','price-lower-warning','原活动退出原因尚未证实。确认即同意按上方价格、时长和额度重新创建活动。'));
  const raised=rows.filter(row=>row.saleFen>row.previousFen),lowered=rows.filter(row=>row.saleFen<row.previousFen),summary=node('div','price-change-summary');summary.append(node('span','badge blue',`调高 ${raised.length} 个规格`),node('span','badge '+(lowered.length?'amber':'neutral'),`调低 ${lowered.length} 个规格`),node('span','badge neutral',`不变 ${rows.length-raised.length-lowered.length} 个规格`));body.append(summary);
  if(lowered.length)body.append(node('p','price-lower-warning',`这份方案需要降价，单个规格最多降低 ${money(Math.max(...lowered.map(row=>row.previousFen-row.saleFen)))}。请核对全部规格后确认。`));
  const manualAllowed=live(source)&&source.manualEditable&&(!source.manualTypes||source.manualTypes.includes(type)),tools=node('div','price-table-tools');tools.append(node('strong','',source.status==='approved'?'当时确认的确切价格':'逐规格价格对照'));
  if(manualAllowed){const edit=node('button','text-button',card.manualMode?'正在手动调整':'手动调整折扣');edit.hidden=card.manualMode;edit.onclick=()=>{if(!eligible(source))return;card.manualMode=true;edit.hidden=true;card.preview.hidden=false;if(card.checkbox)card.checkbox.checked=false;drawRows();updateControls(card);};tools.append(edit);card.edit=edit;}body.append(tools);
  const scroll=node('div','price-table-scroll'),table=node('table','price-table'),thead=node('thead'),head=node('tr'),tbody=node('tbody');table.dataset.role='price-target-table';for(const label of ['规格 / 原价','已有守护价',source.status==='approved'?'已确认价格':'本方案价格','价格变化','平台依据'])head.append(node('th','',label));thead.append(head);table.append(thead,tbody);scroll.append(table);body.append(scroll);
  const pager=node('div','pagination sku-pagination'),pageLabel=node('span'),buttons=node('div'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格');buttons.append(prev,next);pager.append(pageLabel,buttons);body.append(pager);
  function drawRows(){const pages=Math.max(1,Math.ceil(rows.length/25));card.skuPage=Math.max(0,Math.min(card.skuPage,pages-1));tbody.replaceChildren(...rows.slice(card.skuPage*25,(card.skuPage+1)*25).map(row=>{
   const tr=node('tr',row.saleFen!==row.previousFen?'price-changed':''),title=node('td');title.append(node('strong','',row.name||row.id),node('small','',money(row.baseFen)));const before=node('td'),after=node('td'),price=node('strong','',money(row.saleFen));price.dataset.targetPrice=row.id;before.append(node('strong','',money(row.previousFen)),node('small','',discount(row.previousDiscount)));after.append(price);
   if(card.manualMode){const label=node('label','manual-discount-input'),input=node('input');input.type='number';input.min='1';input.max='9.5';input.step='0.1';input.value=card.manualValues.get(row.id);input.dataset.manualSku=row.id;input.setAttribute('aria-label',(row.name||row.id)+'折扣');input.oninput=()=>{card.manualValues.set(row.id,input.value);if(card.checkbox)card.checkbox.checked=false;updateControls(card);};label.append(input,node('span','','折'));after.append(label);}else after.append(node('small','',discount(row.discount)));
   const delta=row.saleFen-row.previousFen,evidence=[...(row.evidence||[])];if(selected?.ratio)evidence.push('最高价不超过最低价的 '+selected.ratio.numerator/selected.ratio.denominator+' 倍');tr.append(title,before,after,node('td','',delta?(delta>0?'提高 ':'降低 ')+money(Math.abs(delta)):'保持不变'),node('td','price-evidence',evidence.join('；')||'保持已核对设置'));return tr;
  }));pageLabel.textContent=`全部 ${rows.length} 个规格 · 第 ${card.skuPage+1} / ${pages} 页`;prev.disabled=card.skuPage===0;next.disabled=card.skuPage>=pages-1;}
  prev.onclick=()=>{card.skuPage--;drawRows();updateControls(card);};next.onclick=()=>{card.skuPage++;drawRows();updateControls(card);};drawRows();
  if(manualAllowed){const preview=node('button','button secondary','预览自定义价格');preview.hidden=!card.manualMode;preview.onclick=async()=>{if(!eligible(source)||!isCurrentCard(card))return;preview.disabled=true;try{const discounts=source.rows.map(row=>({id:row.id,discount:Number(card.manualValues.get(row.id))*10})),result=await post('price-reviews/preview',{shopId:source.shopId,reviewId:source.id,key:source.key,activityType:type,discounts});if(!isCurrentCard(card)||getState().state?.shopId!==source.shopId)return;const option=result.option,nextSource={...source,options:[...(source.options||[]).filter(o=>o.id!=='manual-discount'),option]},next=buildCard(nextSource,{...card,signature:JSON.stringify(nextSource),selectedOptionId:option.id,manualMode:true,checkbox:null},first);replaceCard(source.id,next);card.el.replaceWith(next.el);}catch(error){toast(error.message);}finally{preview.disabled=false;}};body.append(preview);card.preview=preview;}
  if(live(source)){const consent=node('label','check-label price-consent'),checkbox=node('input');checkbox.type='checkbox';checkbox.checked=same&&previous.selectedOptionId===card.selectedOptionId&&previous.checkbox?.checked===true;consent.append(checkbox,node('span','',`我已核对本商品全部 ${rows.length} 个规格，同意${type?'「'+type+'」活动、':''}上方确切价格及活动规则，并按这些价格继续守护。${source.kind==='limited-rebuild'?'我理解需重新提供上方限量额度。':''}`));const actions=node('div','price-review-actions'),approve=node('button','button primary','确认表内价格并继续守护'),decline=node('button','button secondary','暂不调整');actions.append(approve,decline);body.append(consent,actions);Object.assign(card,{checkbox,approve,decline});checkbox.onchange=()=>updateControls(card);approve.onclick=()=>void decide(card,'approve');decline.onclick=()=>void decide(card,'decline');}
  const foot=node('div','price-review-foot'),note=node('p','helper');foot.append(note);card.note=note;if((!source.readOnly||source.canRecalculate)&&(['pending','declined'].includes(source.status)||source.requiresReconfirmation)){const recalculate=node('button','text-button','重新核对');recalculate.onclick=()=>void decide(card,'recalculate');card.recalculate=recalculate;foot.append(recalculate);}body.append(foot);
  const facts=node('details','price-source-details');facts.append(node('summary','','查看来源和核验信息'),node('p','helper',`商品 ${source.productId} · 记录 ${time(source.createdAt)}${source.status==='pending'?' · 有效至 '+time(source.expiresAt):''}`));if(source.skippedSkuIds?.length)facts.append(node('p','helper',`${source.skippedSkuIds.length} 个历史规格当前缺失，本表只包含已核对规格，完整历史仍保留。`));body.append(facts);updateControls(card);return card;
 }
 return{buildCard,updateControls};
}
