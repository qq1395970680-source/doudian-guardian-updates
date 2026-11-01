export function createRecoveryBlockers({getState,post,toast,node,time,navigate}){
 const $=id=>document.getElementById(id);let shop=null,onlyMode=null,filter='both',page=0,pages=1,loading=false,generation=0;
 const labels={blocked:'平台已拒绝',verified:'该次已回读',unverified:'尚未核验'};
 const friendly=value=>String(value||'').replace(/^[A-Z_]+:\s*/, '');
 function render(result){
  $('blocker-both-count').textContent=result.counts.bothBlocked;$('blocker-other-count').textContent=result.counts.total-result.counts.bothBlocked;
  $('blocker-page-label').textContent=`${result.total} 件 · 第 ${result.page+1} / ${result.pages} 页`;page=result.page;pages=result.pages;
  $('blocker-prev').disabled=page===0;$('blocker-next').disabled=page>=pages-1;
  const cards=result.records.map(record=>{
   const card=node('article','panel blocker-card'),head=node('div','section-head'),body=node('div');card.dataset.recoveryBlocker=record.productId;
   body.append(node('h2','',record.name),node('p','helper',record.productId));head.append(body,node('span','badge '+(record.bothBlocked?'amber':'blue'),record.bothBlocked?'两种均受阻':record.state==='verifying'?'正在核验':'待处理'));card.append(head);
   const schemes=node('div','blocker-schemes');for(const type of ['限时抢购','限量抢购']){
    const s=record.schemes[type],item=node('section','blocker-scheme'),heading=node('div','button-row');heading.append(node('h3','',type),node('span','badge '+(s.state==='blocked'&&!s.outdated?'amber':s.state==='verified'?'green':'neutral'),s.outdated?'价格目标已变，待重核':labels[s.state]||'待核验'));
    item.append(heading,node('p','reason',friendly(s.message)),node('small','helper',s.at?'记录于 '+time(s.at):'没有将未核验方案计作失败'));schemes.append(item);
   }card.append(schemes,node('p','helper',record.note),node('p','reason',friendly(record.message)));
   const actions=node('div','button-row'),retry=node('button','button secondary',record.state==='verifying'?'正在核验':'重新核验恢复');
   const current=getState();retry.disabled=record.state==='verifying'||!current.online||current.state?.connection?.shopId!==shop;
   retry.onclick=async()=>{retry.disabled=true;try{await post('recovery/request',{shopId:shop,productId:record.productId});toast('已加入核验队列；没有批准新价格或切换活动类型。');}catch(e){toast(e.message);}finally{void refresh();}};actions.append(retry);
   if(record.pendingReview&&!record.pricingDeferred){const price=node('button','button small secondary','查看价格确认');price.onclick=()=>navigate('prices');actions.append(price);}
   card.append(actions);return card;
  });
  $('blocker-records').replaceChildren(...(cards.length?cards:[node('div','panel empty',filter==='both'?'当前没有同一价格方案下限时、限量均明确受阻的商品。可切换查看其他待核验项。':'当前没有符合条件的受阻商品。')]));
 }
 async function refresh(){if(loading)return;loading=true;const expectedShop=shop,expected=generation;
  try{const response=await fetch(`/api/recovery-blockers?filter=${filter}&page=${page}&q=${encodeURIComponent($('blocker-search').value)}`,{signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error();const result=await response.json();if(result.shopId!==expectedShop||generation!==expected)return;$('blocker-feedback').hidden=true;render(result);
  }catch{$('blocker-feedback').hidden=false;$('blocker-feedback').textContent='受阻记录暂时无法读取，正在重连。';}
  finally{loading=false;if(generation!==expected)void refresh();}
 }
 for(const button of document.querySelectorAll('[data-blocker-filter]'))button.onclick=()=>{filter=button.dataset.blockerFilter;page=0;generation++;for(const b of document.querySelectorAll('[data-blocker-filter]'))b.classList.toggle('selected',b===button);void refresh();};
 $('blocker-prev').onclick=()=>{page=Math.max(0,page-1);generation++;void refresh();};$('blocker-next').onclick=()=>{page=Math.min(pages-1,page+1);generation++;void refresh();};
 let timer;$('blocker-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{page=0;generation++;void refresh();},250);};
 return{sync(){const next=getState().state?.shopId||null,mode=getState().state?.originalPriceRecoveryEnabled===true;if(shop!==next||onlyMode!==mode){shop=next;onlyMode=mode;filter=mode?'all':'both';for(const b of document.querySelectorAll('[data-blocker-filter]'))b.classList.toggle('selected',b.dataset.blockerFilter===filter);page=0;generation++;$('blocker-records').replaceChildren(node('div','panel empty','正在读取受阻记录'));}},refresh};
}
