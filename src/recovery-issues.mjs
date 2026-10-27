// Presentation only. These rows never grant permission or supply task prices.
export function buildRecoveryIssues(catalog,reviews=[]){
 const pending=new Set(reviews.filter(r=>r.status==='pending').map(r=>r.productId));
 const ignored=new Set(['PRODUCT_RECYCLED','OFF_SHELF']);
 return(catalog?.products||[]).filter(p=>p.history&&!p.excluded&&!p.pending&&!p.current.length&&!p.scheduled.length&&
  !ignored.has(p.check?.code)&&!pending.has(p.productId)).map(p=>({productId:p.productId,name:p.name,code:p.check?.code||'CURRENT_RECHECK_PENDING',
   message:p.check?.message||p.reason||'当前活动证据待更新，程序需要重新核验后才能恢复；此状态不表示已经恢复。',
   at:p.check?.at||p.observedAt||null,retryAt:p.check?.retryAt||null,stale:catalog.stale||p.stale,
   canRequest:true,pricing:['SKU_RATIO_REVIEW_REQUIRED','PRICE_REVIEW_REQUIRED','PRICE_RECONFIRM_REQUIRED'].includes(p.check?.code)}));
}
