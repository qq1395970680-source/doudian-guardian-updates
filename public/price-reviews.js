import {createPriceReviewCards} from './price-review-card.js';
// A read-only proposal never grants consent. The only approval path is the
// unchecked checkbox and explicit button below; prices are never sent by UI.
export function createPriceReviews({getState,post,toast,node,money,discount,time}) {
 const $=id=>document.getElementById(id),cards=new Map(),pageSize=10,skuPageSize=25;
 let shop=null,reviews=[],pageIndex=0,total=0,pages=1,loading=false,readAt=0,action=null,visibleIds='',loadVersion=0,direction='increase';
 let issues=[],issuePage=0,issueSignature='';
 let rechecks={records:[],total:0,pending:0,page:0,pages:1},recheckPage=0,recheckSignature='';
 const labels={pending:'等待确认',approved:'已确认',declined:'暂不调整',superseded:'已失效'};
 const current=()=>getState();
 const visibleSuggestion=r=>!['pending','declined'].includes(r.status)||!Number.isFinite(r.expiresAt)||r.expiresAt>Date.now();
 const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 function reset(next){shop=next;reviews=[];issues=[];issuePage=0;issueSignature='';rechecks={records:[],total:0,pending:0,page:0,pages:1};recheckPage=0;recheckSignature='';$('price-rechecks-panel').hidden=true;$('recovery-issues-panel').hidden=true;pageIndex=0;total=0;pages=1;readAt=0;loadVersion++;cards.clear();visibleIds='';for(const mode of ['increase','decrease'])setText($('price-'+mode+'-count'),'—');$('price-reviews').replaceChildren(node('div','empty','正在读取价格建议'));pagination();}
 function renderRechecks(){
  const signature=JSON.stringify([shop,rechecks,current().online,current().state?.connection?.shopId,action]);if(signature===recheckSignature)return;recheckSignature=signature;
  $('price-rechecks-panel').hidden=!rechecks.total;setText($('price-rechecks-count'),`${rechecks.pending} 件待处理`);
  setText($('price-rechecks-page'),`${rechecks.total} 件 · 第 ${rechecks.page+1} / ${rechecks.pages} 页`);
  $('price-rechecks-prev').disabled=loading||rechecks.page===0;$('price-rechecks-next').disabled=loading||rechecks.page>=rechecks.pages-1;
  const states={queued:'已排队',paused:'等待继续',verifying:'正在核验',blocked:'核对受阻',skipped:'已跳过',checked:'核验已结束',verified:'该次恢复已回读'};
  const rows=rechecks.records.map(record=>{
   const row=node('div','setting-row'),body=node('div'),heading=node('div','button-row');row.dataset.priceRecheck=record.productId;
   heading.append(node('strong','',record.name),node('span','badge '+(record.state==='verified'?'green':record.state==='blocked'?'amber':'blue'),states[record.state]||'等待核对'));
   body.append(heading,node('p','helper',record.productId+(record.code?' · '+record.code:'')),node('p','reason',record.message),node('p','helper',`请求 ${time(record.requestedAt)} · 更新 ${time(record.updatedAt)}`));
   if(record.campaignId)body.append(node('p','helper',`活动 ${record.campaignId} · ${record.skuCount} 个规格 · 回读 ${time(record.verifiedAt)}`));
   row.append(body);
   if(['blocked','paused'].includes(record.state)){
    const retry=node('button','button small secondary','重新核验恢复');retry.disabled=!!action||!current().online||current().state?.connection?.shopId!==shop;
    retry.onclick=async()=>{retry.disabled=true;try{await post('recovery/request',{shopId:shop,productId:record.productId});toast('已加入优先核验队列，请在这里查看进度；新价格仍需单独确认。');}catch(error){toast(error.message);}finally{readAt=0;recheckSignature='';void refresh();}};
    row.append(retry);
   }return row;
  });$('price-rechecks').replaceChildren(...rows);
 }
 $('price-rechecks-prev').onclick=()=>{recheckPage=Math.max(0,recheckPage-1);void refresh();};
 $('price-rechecks-next').onclick=()=>{recheckPage++;void refresh();};
 function renderIssues(){
  const signature=JSON.stringify([shop,issuePage,issues,current().online,current().state?.connection?.shopId,action]);if(signature===issueSignature)return;issueSignature=signature;
  const count=issues.length,issuePages=Math.max(1,Math.ceil(count/10));issuePage=Math.min(issuePage,issuePages-1);$('recovery-issues-panel').hidden=!count;
  setText($('recovery-issues-count'),String(count));setText($('recovery-issues-page'),`${count} 件 · 第 ${issuePage+1} / ${issuePages} 页`);
  $('recovery-issues-prev').disabled=issuePage===0;$('recovery-issues-next').disabled=issuePage>=issuePages-1;
  const rows=issues.slice(issuePage*10,(issuePage+1)*10).map(issue=>{
   const row=node('div','setting-row'),body=node('div');row.dataset.recoveryIssue=issue.productId;
   body.append(node('strong','',issue.name||'商品 '+issue.productId),node('p','helper',issue.productId+' · '+issue.code),node('p','reason',issue.message),
    node('p','helper',`最近核对 ${time(issue.at)}${issue.stale?' · 证据待更新':''}`));
   const button=node('button','button small secondary','重新核验恢复');button.disabled=!!action||!current().online||current().state?.connection?.shopId!==shop;
   button.onclick=async()=>{button.disabled=true;try{await post('recovery/request',{shopId:shop,productId:issue.productId});toast('已加入优先核验队列；原价恢复不需要新增价格确认，调价仍需确认。');}catch(error){toast(error.message);}finally{readAt=0;issueSignature='';void refresh();}};
   row.append(body,button);return row;
  });$('recovery-issues').replaceChildren(...rows);
 }
 $('recovery-issues-prev').onclick=()=>{issuePage=Math.max(0,issuePage-1);renderIssues();};
 $('recovery-issues-next').onclick=()=>{issuePage++;renderIssues();};
 function pagination(){$('price-page-label').textContent=total?`${total} 份记录 · 第 ${pageIndex+1} / ${pages} 页`:'0 份记录';$('price-prev').disabled=loading||!!action||pageIndex===0;$('price-next').disabled=loading||!!action||pageIndex===pages-1;}
 function directionHeading(){
  for(const b of document.querySelectorAll('[data-price-direction]')){const selected=b.dataset.priceDirection===direction;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));b.disabled=!!action;}
  setText($('price-direction-title'),direction==='increase'?'需要调高的商品':direction==='decrease'?'需要调低的商品':'全部价格记录');
  setText($('price-direction-detail'),direction==='increase'?'这里只显示全部规格均提价或不变的待确认方案。展开商品核对后，可直接确认并继续守护。':direction==='decrease'?'只要有一个规格建议降价，整件商品就放在这里。混合提价也一并展示；请核对全部规格和利润后再确认。':'查看待确认、已确认、暂不调整和已失效的完整记录。确认价格不等于恢复成功，请查看独立回读结果。');
 }
 const {buildCard,updateControls}=createPriceReviewCards({getState,post,toast,node,money,discount,time,getReadAt:()=>readAt,getAction:()=>action,
  onAction(value){action=value;loadVersion++;for(const c of cards.values())updateControls(c);pagination();directionHeading();},
  onReview(review){reviews=reviews.map(row=>row.id===review.id?review:row);render();},
  onSettled(){readAt=0;void refresh();},replaceCard(id,card){cards.set(id,card);}});
 function render(){
  reviews=reviews.filter(visibleSuggestion);const rows=reviews;let replaced=false;
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
   try{const response=await fetch(`/api/price-reviews?page=${pageIndex}&size=${pageSize}&direction=${direction}&recheckPage=${recheckPage}`,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('价格建议暂时无法读取');const result=await response.json();
    if(shop!==expectedShop||result.shopId!==shop||loadVersion!==expectedVersion||action)return;
    if(!Array.isArray(result.reviews)||result.reviews.length>pageSize||!Number.isSafeInteger(result.total)||!Number.isSafeInteger(result.pages)||!Number.isSafeInteger(result.page))throw Error('价格建议分页待重新读取');
    reviews=result.reviews;issues=Array.isArray(result.recoveryIssues)?result.recoveryIssues:[];rechecks=result.rechecks&&Array.isArray(result.rechecks.records)?result.rechecks:{records:[],total:0,pending:0,page:0,pages:1};recheckPage=rechecks.page;total=result.total;pages=result.pages;pageIndex=result.page;readAt=Date.now();
    for(const mode of ['increase','decrease'])setText($('price-'+mode+'-count'),String(result.directionCounts?.[mode]??0));
    render();renderIssues();renderRechecks();
   }catch{readAt=0;if(!reviews.length)$('price-reviews').replaceChildren(node('div','empty','价格建议暂时无法读取，正在重新连接。'));for(const c of cards.values())updateControls(c);}
   finally{loading=false;pagination();$('price-rechecks-prev').disabled=rechecks.page===0;$('price-rechecks-next').disabled=rechecks.page>=rechecks.pages-1;if(loadVersion!==expectedVersion&&!action)void refresh();}
  }
 return {
  sync(){if(shop!==current().state?.shopId)reset(current().state?.shopId||null);if(reviews.some(r=>!visibleSuggestion(r))){render();if(!loading&&!action)void refresh();}for(const c of cards.values())updateControls(c);},
  refresh
 };
}
