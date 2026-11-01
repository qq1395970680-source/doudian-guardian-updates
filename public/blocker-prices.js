import {renderActivityPrices} from './activity-prices.js';
import {createPriceReviewCards} from './price-review-card.js';

export function createBlockerPrices({getState,post,toast,node,money,discount,time}){
 let record=null,shop=null,card=null,action=null,readAt=0,generation=0,loading=false,pending=false;
 const dialog=node('dialog','blocker-price-dialog'),head=node('div','section-head'),title=node('h2','','调整受阻商品价格'),close=node('button','button secondary','关闭'),body=node('div');
 const notice=node('p','reason');notice.hidden=true;const notify=message=>{if(dialog.open){notice.textContent=message;notice.hidden=false;}toast(message);};close.type='button';head.append(title,close);dialog.append(head,notice,node('p','helper','自动恢复继续沿用原折扣价。这里的确认只适用于本商品，确认后先核验平台要求，再恢复并独立回读。'),body);document.body.append(dialog);
 const state=()=>getState();
 const {buildCard,updateControls}=createPriceReviewCards({getState:state,post,toast:notify,node,money,discount,time,context:'recovery-blockers',endpoint:'recovery-blockers/prices/decide',isCurrentCard:value=>card===value,getReadAt:()=>readAt,getAction:()=>action||(pending?'pending-verification':null),
  onAction(value){action=value;close.disabled=!!value;if(card)updateControls(card);},
  onReview(review){card=buildCard(review,card,true);body.replaceChildren(card.el);},onSettled(){readAt=0;void refresh();},replaceCard(id,next){card=next;}});
 function dismiss(){if(action)return;generation++;record=null;card=null;dialog.close();}
 close.onclick=dismiss;dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 async function refresh(){if(!record||loading||action)return;loading=true;const expected=generation,productId=record.productId;
  try{const response=await fetch('/api/recovery-blockers/prices?productId='+encodeURIComponent(productId),{signal:AbortSignal.timeout(10000)}),result=await response.json();if(!response.ok)throw Error(result.message||'价格暂时无法读取');
   if(expected!==generation||shop!==getState().state?.shopId||result.shopId!==shop)return;readAt=Date.now();pending=result.blocked;
   if(!result.review){card=null;const retry=node('button','button secondary','重新核对价格');retry.disabled=pending||!getState().online||getState().state?.connection?.shopId!==shop;retry.onclick=async()=>{retry.disabled=true;try{if(result.recheckReview)await post('recovery-blockers/prices/decide',{shopId:shop,reviewId:result.recheckReview.id,key:result.recheckReview.key,decision:'recalculate'});else await post('recovery/request',{shopId:shop,productId});notify('已请求重新核对价格；新的方案会显示在这里。');}catch(e){notify(e.message);}finally{void refresh();}};body.replaceChildren(renderActivityPrices({comparison:result.comparison,node,money,discount,time}),node('p','reason',pending?'此商品有未完成或结果未知的任务，先独立核实后再调价。':'当前没有有效价格建议；先重新核对平台要求，过期建议不会显示。'),retry);return;}
   let review=result.review;
   if(card?.source.key===review.key&&card.source.id===review.id){const manual=card.source.options?.find(o=>o.id==='manual-discount');if(manual&&review.manualTypes?.includes(manual.activityType)&&manual.basisKey===review.manualBasisKeys?.[manual.activityType])review={...review,options:[...review.options,manual]};}
   if(card?.signature!==JSON.stringify(review)){card=buildCard(review,card,true);body.replaceChildren(card.el);}const old=body.querySelector('[data-pending-price]');if(old)old.remove();if(pending){const note=node('p','reason','此商品有未完成或结果未知的任务，先独立核实后再调价。');note.dataset.pendingPrice='true';body.prepend(note);}updateControls(card);
  }catch(e){readAt=0;if(card)updateControls(card);else body.replaceChildren(node('p','reason',e.message));}
  finally{loading=false;if(expected!==generation&&record)void refresh();}
 }
 return{async open(value){if(action)return;generation++;notice.hidden=true;record=value;shop=getState().state?.shopId;card=null;pending=false;readAt=0;title.textContent=value.name+' · 调整价格';body.replaceChildren(node('p','helper','正在读取当前有效价格方案'));if(!dialog.open)dialog.showModal();await refresh();},sync(){if(!record)return;if(shop!==getState().state?.shopId){dismiss();return;}if(card?.source.status==='pending'&&card.source.expiresAt<=Date.now()){card=null;readAt=0;body.replaceChildren(node('p','reason','当前没有有效价格建议；请重新核对平台要求。'));}if(card)updateControls(card);if(!action&&Date.now()-readAt>8000)void refresh();}};
}
