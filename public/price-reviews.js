// Pending decisions are summaries; exact prices have one shared drawer.
export function createPriceReviews({getState,node,money,time,openPricing,navigate}){
 const $=id=>document.getElementById(id);let shop=undefined,scope='pending',direction='all',page=0,pages=1,loading=false,generation=0,signature='';
 function headings(){
  for(const b of document.querySelectorAll('[data-price-scope]')){const selected=b.dataset.priceScope===scope;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));}
  for(const b of document.querySelectorAll('[data-price-direction]')){const selected=b.dataset.priceDirection===direction;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));b.hidden=scope==='history'&&b.dataset.priceDirection!=='all';}
  $('price-direction-title').textContent=scope==='history'?'确认历史':direction==='decrease'?'需要你确认的降价':direction==='increase'?'其他待确认价格':'需要你确认的商品';
  $('price-direction-detail').textContent=scope==='history'?'保留每次确切价格的确认记录。恢复结果请查看恢复记录。':'能安全自动恢复的由后台处理。这里只列需要你核对的价格，一件商品只保留一个待办。';
 }
 function render(result){
  const renderedScope=scope;
  page=result.page;pages=result.pages;$('price-page-label').textContent=`${result.total} 份记录 · 第 ${page+1} / ${pages} 页`;$('price-prev').disabled=page===0;$('price-next').disabled=page>=pages-1;
  for(const mode of ['increase','decrease'])$('price-'+mode+'-count').textContent=String(result.directionCounts?.[mode]??0);
  const next=JSON.stringify([shop,scope,result.reviews]);if(signature===next)return;signature=next;
  const rows=(result.reviews||[]).map(review=>{
   const row=node('article','price-queue-row'),body=node('div','price-queue-copy'),head=node('div','button-row');row.dataset.reviewId=review.id;row.dataset.priceProduct=review.productId;
   const raised=review.rows.filter(s=>s.saleFen>s.previousFen),lowered=review.rows.filter(s=>s.saleFen<s.previousFen);
   head.append(node('strong','',review.name||'商品 '+review.productId),node('span','badge '+(review.status==='pending'?'amber':'neutral'),review.status==='pending'?(lowered.length?'需要降价确认':'需要核对方案'):review.status==='approved'?'已确认价格':review.status==='declined'?'暂不调整':'历史记录'));
   body.append(head,node('p','helper',review.status==='pending'?`${review.rows.length} 个规格 · ${review.type||'活动规则待核对'}${lowered.length?' · '+lowered.length+' 个需降价，单个最多降低 '+money(Math.max(...lowered.map(s=>s.previousFen-s.saleFen))):raised.length?' · '+raised.length+' 个规格提价':' · 价格或来源需重新核对'}`:`${time(review.approvedAt||review.createdAt)} · ${review.rows.length} 个规格`));
   const button=node('button','button small '+(review.status==='pending'?'primary':'secondary'),review.status==='pending'?'核对价格':'查看记录');button.dataset.openPriceReview=review.productId;button.onclick=()=>openPricing({...review,reviewId:renderedScope==='history'?review.id:null});row.append(body,button);return row;
  });
  if(!rows.length){const empty=node('div','empty');empty.append(node('strong','',scope==='history'?'暂无确认记录':'当前没有需要你确认的价格'),node('p','',scope==='history'?'今后的确认会保留在这里。':'后台会继续自动核验。读取、提交等问题统一在恢复受阻查看。'));if(scope==='pending'){const go=node('button','button small secondary','查看恢复受阻');go.onclick=()=>navigate('blockers');empty.append(go);}rows.push(empty);}$('price-reviews').replaceChildren(...rows);
 }
 async function refresh(){if(loading||!shop)return;loading=true;const expected=generation,expectedShop=shop;try{const response=await fetch(`/api/price-reviews?scope=${scope}&direction=${direction}&page=${page}&size=10`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();const result=await response.json();if(expected!==generation||expectedShop!==shop||result.shopId!==shop)return;render(result);}catch{if(!signature)$('price-reviews').replaceChildren(node('div','empty','价格待办暂时无法读取，正在重新连接。'));}finally{loading=false;if(expected!==generation)void refresh();}}
 for(const button of document.querySelectorAll('[data-price-direction]'))button.onclick=()=>{direction=button.dataset.priceDirection;page=0;generation++;signature='';headings();void refresh();};
 for(const button of document.querySelectorAll('[data-price-scope]'))button.onclick=()=>{scope=button.dataset.priceScope;direction='all';page=0;generation++;signature='';headings();$('price-reviews').replaceChildren(node('div','empty',scope==='history'?'正在读取确认历史':'正在读取价格待办'));void refresh();};
 $('price-prev').onclick=()=>{page=Math.max(0,page-1);generation++;void refresh();};$('price-next').onclick=()=>{page=Math.min(pages-1,page+1);generation++;void refresh();};
 return{sync(){const next=getState().state?.shopId||null;if(shop!==next){shop=next;scope='pending';direction='all';page=0;generation++;signature='';headings();$('price-reviews').replaceChildren(node('div','empty',shop?'正在读取价格待办':'连接店铺后，这里显示需要你确认的价格。'));}for(const id of ['price-rechecks-panel','recovery-issues-panel'])if($(id))$(id).hidden=true;},refresh};
}
