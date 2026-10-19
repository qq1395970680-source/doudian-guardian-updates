// A read-only proposal never grants consent. The only approval path is the
// unchecked checkbox and explicit button below; prices are never sent by UI.
export function createPriceReviews({getState,post,toast,node,money,discount,time}) {
 const $=id=>document.getElementById(id),cards=new Map(),pageSize=10,skuPageSize=25;
 let shop=null,reviews=[],pageIndex=0,loading=false,readAt=0,action=null,visibleIds='';
 const labels={pending:'等待确认',approved:'已确认',declined:'暂不降价',superseded:'已失效'};
 const current=()=>getState();
 const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 function reset(next){shop=next;reviews=[];pageIndex=0;readAt=0;cards.clear();visibleIds='';$('price-reviews').replaceChildren(node('div','empty','正在读取价格建议'));}
 function eligible(r){const s=current();return s.online&&s.state?.shopId===r.shopId&&s.state?.connection?.shopId===r.shopId&&Date.now()-readAt<15000&&!action;}
 function updateControls(card){
  const {r}=card,expired=r.expiresAt<=Date.now(),ready=eligible(r);
  setText(card.badge,r.status==='pending'&&expired?'建议已过期':labels[r.status]||'等待更新');
  if(card.checkbox){card.checkbox.disabled=!ready||expired;card.approve.disabled=!ready||expired||!card.checkbox.checked;}
  if(card.decline)card.decline.disabled=!ready;
  if(card.recalculate)card.recalculate.disabled=!ready;
  if(card.note)setText(card.note,!current().online?'暂时离线，重新连接后才能确认。':current().state?.connection?.shopId!==r.shopId?'请先连接并核对当前店铺。':expired?'这份建议已过期，请重新核对平台要求。':`有效至 ${time(r.expiresAt)} · 确认后，后台会重新核对商品再执行。`);
 }
 async function decide(card,decision){
  const r=card.r;if(!eligible(r))return;
  if(decision==='approve'&&(!card.checkbox?.checked||r.expiresAt<=Date.now()))return;
  action=r.id;for(const c of cards.values())updateControls(c);
  try{
   const args={shopId:r.shopId,reviewId:r.id,key:r.key,decision};
   if(decision==='approve')Object.assign(args,{confirmedSkuIds:r.rows.map(row=>row.id),acceptPriceAndRisk:true});
   const result=await post('price-reviews/decide',args);
   if(shop!==r.shopId)return;
   reviews=reviews.map(row=>row.id===r.id?result.review:row);render();
   toast(decision==='approve'?'表内价格已确认。开启守护时，后台会重新核对后执行。':decision==='decline'?'已保留原设置，不采用这份降价建议。':'已请求重新核对；新的建议仍需你确认。');
  }catch(e){toast(e.message);readAt=0;}
  finally{action=null;for(const c of cards.values())updateControls(c);}
 }
 function buildCard(r,previous,first){
  const el=node('details','panel price-review'),summary=node('summary','price-review-heading'),title=node('div');
  el.dataset.reviewId=r.id;el.open=previous?.el.open??(first&&r.status==='pending');
  title.append(node('h2','',r.name||'商品 '+r.productId),node('p','',`${r.productId} · ${r.rows.length} 个规格 · ${r.rows.filter(s=>s.saleFen<s.previousFen).length} 个建议调整`));
  const badge=node('span','badge '+(r.status==='approved'?'green':'amber'));summary.append(title,badge);el.append(summary);
  const card={el,r,badge,signature:JSON.stringify(r),skuPage:previous?.skuPage||0};let populated=false;
  function populate(){if(populated)return;populated=true;
   const body=node('div','price-review-body'),caption=node('p','helper','下表包含本商品全部规格。已有守护价与建议价由已核对原价 × 折扣计算；未调整的规格保持原设置。');
   body.append(caption);
   if(r.skippedSkuIds?.length)body.append(node('p','detail-note',`${r.skippedSkuIds.length} 个历史规格当前缺失，本次未包含；完整历史仍保留。`));
   const scroll=node('div','price-table-scroll'),table=node('table','price-table'),head=node('thead'),tr=node('tr'),tbody=node('tbody');
   for(const h of ['规格 / 原价','已有守护价','建议守护价','降幅','平台依据'])tr.append(node('th','',h));head.append(tr);table.append(head,tbody);scroll.append(table);body.append(scroll);
   const pagination=node('div','pagination sku-pagination'),label=node('span'),buttons=node('div'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格');
   buttons.append(prev,next);pagination.append(label,buttons);body.append(pagination);
   const drawRows=()=>{const pages=Math.max(1,Math.ceil(r.rows.length/skuPageSize));card.skuPage=Math.min(card.skuPage,pages-1);const fragment=document.createDocumentFragment();
    for(const row of r.rows.slice(card.skuPage*skuPageSize,(card.skuPage+1)*skuPageSize)){
     const tr=node('tr',row.saleFen<row.previousFen?'price-changed':''),name=node('td');name.append(node('strong','',row.name||row.id),node('small','',money(row.baseFen)));
     const before=node('td'),after=node('td');before.append(node('strong','',money(row.previousFen)),node('small','',discount(row.previousDiscount)));after.append(node('strong','',money(row.saleFen)),node('small','',discount(row.discount)));
     const amount=row.previousFen-row.saleFen,change=amount>0?`${money(amount)} / ${(amount/row.previousFen*100).toFixed(2)}%`:'不变';
     tr.append(name,before,after,node('td','',change),node('td','price-evidence',row.evidence.join('；')||'保持原设置'));fragment.append(tr);
    }
    tbody.replaceChildren(fragment);label.textContent=`全部 ${r.rows.length} 个规格 · 第 ${card.skuPage+1} / ${pages} 页`;prev.disabled=card.skuPage===0;next.disabled=card.skuPage===pages-1;
   };prev.onclick=()=>{card.skuPage--;drawRows();};next.onclick=()=>{card.skuPage++;drawRows();};drawRows();
   if(r.status==='pending'){
    const consent=node('label','check-label price-consent'),checkbox=node('input');checkbox.type='checkbox';
    // Never preserve consent across a changed/expired proposal or account.
    checkbox.checked=previous?.signature===card.signature&&previous.checkbox?.checked===true;
    consent.append(checkbox,node('span','',`我已核对本商品全部 ${r.rows.length} 个规格，同意表内价格及对应的低价风险提示，并按这些确切价格继续守护。`));body.append(consent);
    const actions=node('div','price-review-actions'),approve=node('button','button primary','确认表内价格并继续守护'),decline=node('button','button secondary','暂不降价');
    actions.append(approve,decline);body.append(actions);Object.assign(card,{checkbox,approve,decline});
    checkbox.onchange=()=>updateControls(card);approve.onclick=()=>void decide(card,'approve');decline.onclick=()=>void decide(card,'decline');
   }
   if(['pending','declined'].includes(r.status)){
    const row=node('div','price-review-foot'),note=node('p','helper'),recalculate=node('button','text-button','重新核对');row.append(note,recalculate);body.append(row);Object.assign(card,{note,recalculate});recalculate.onclick=()=>void decide(card,'recalculate');
   }else body.append(node('p','helper',r.status==='approved'?'已记录本表的确切价格。是否恢复成功，请以商品折扣及独立回读结果为准。':(r.supersededReason||'已请求重新核对')+'；这份建议不会用于执行。'));
   el.append(body);updateControls(card);
  }
  el.addEventListener('toggle',()=>{if(el.open)populate();});if(el.open)populate();updateControls(card);return card;
 }
 function render(){
  const sorted=[...reviews].sort((a,b)=>Number(b.status==='pending')-Number(a.status==='pending')||b.createdAt-a.createdAt),pages=Math.max(1,Math.ceil(sorted.length/pageSize));pageIndex=Math.min(pageIndex,pages-1);
  const rows=sorted.slice(pageIndex*pageSize,(pageIndex+1)*pageSize);let replaced=false;
  for(const [i,r] of rows.entries()){const previous=cards.get(r.id);if(previous?.signature!==JSON.stringify(r)){const c=buildCard(r,previous,i===0);cards.set(r.id,c);if(previous?.el.isConnected)previous.el.replaceWith(c.el);else replaced=true;}}
  const ids=JSON.stringify(rows.map(r=>r.id));if(ids!==visibleIds||replaced){$('price-reviews').replaceChildren(...rows.map(r=>cards.get(r.id).el));visibleIds=ids;}
  if(!rows.length)$('price-reviews').replaceChildren(node('div','empty',shop?'当前没有价格确认事项。平台出现明确的规格价格限制后，建议会显示在这里。':'连接店铺后，这里会显示需要你确认的价格建议。'));
  for(const [id,c] of cards){if(!reviews.some(r=>r.id===id))cards.delete(id);else updateControls(c);}
  $('price-page-label').textContent=sorted.length?`${sorted.length} 份记录 · 第 ${pageIndex+1} / ${pages} 页`:'0 份记录';$('price-prev').disabled=pageIndex===0;$('price-next').disabled=pageIndex===pages-1;
 }
 $('price-prev').onclick=()=>{pageIndex--;render();};$('price-next').onclick=()=>{pageIndex++;render();};
 return {
  sync(){if(shop!==current().state?.shopId)reset(current().state?.shopId||null);for(const c of cards.values())updateControls(c);},
  async refresh(){if(loading)return;loading=true;const expectedShop=shop;
   try{const response=await fetch('/api/price-reviews',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('价格建议暂时无法读取');const result=await response.json();
    if(shop!==expectedShop||result.shopId!==shop)return;reviews=result.reviews;readAt=Date.now();render();
   }catch{readAt=0;if(!reviews.length)$('price-reviews').replaceChildren(node('div','empty','价格建议暂时无法读取，正在重新连接。'));for(const c of cards.values())updateControls(c);}
   finally{loading=false;}
  }
 };
}
