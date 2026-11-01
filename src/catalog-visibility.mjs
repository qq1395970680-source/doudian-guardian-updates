import {fingerprint} from './policy.mjs';

// Presentation preference only. Retain the last independently verified removal
// even after freshness expires; this never supplies execution evidence/consent.
export function hiddenInactiveProductIds({shopId,checks=[],catalog,now=Date.now()}){
 const products=new Map((catalog?.products||[]).map(p=>[p.productId,p]));
 return [...new Set(checks.filter(check=>{
  const proof=check.productState,p=products.get(check.productId);
  if(check.shopId!==shopId||!proof||proof.shopId!==shopId||proof.productId!==check.productId||proof.complete!==true||
   !Number.isFinite(proof.observedAt)||proof.observedAt<=0||proof.observedAt>now+5000)return false;
  if(p&&(p.current.length||p.scheduled.length||p.pending||p.ambiguous))return false;
  return check.code==='OFF_SHELF'&&proof.kind==='off-shelf'&&proof.source==='live-platform-product-management'&&proof.status==='已下架'||
   check.code==='PRODUCT_RECYCLED'&&proof.kind==='recycled'&&proof.source==='live-platform-product-recycle';
 }).map(check=>check.productId))];
}

export function visibleCatalog(catalog,hiddenProductIds=[]){
 const hidden=new Set(hiddenProductIds),products=catalog.products.filter(p=>!hidden.has(p.productId));
 // Hidden products have no current/scheduled activity or unresolved submission.
 const counts={...catalog.counts,products:products.length,missingProducts:products.filter(p=>p.state==='missing').length,
  pendingProducts:products.filter(p=>p.pending).length,unconfirmedProducts:products.filter(p=>p.state==='unconfirmed').length,
  excludedProducts:products.filter(p=>p.excluded).length,recycledProducts:products.filter(p=>p.state==='recycled').length,
  offShelfProducts:products.filter(p=>p.state==='off-shelf').length,recoveryFailedProducts:products.filter(p=>p.recoveryFailure).length,
  historicalProducts:products.filter(p=>p.history).length};
 const {revision,...raw}=catalog,result={...raw,counts,products};
 return{...result,revision:fingerprint(result)};
}
