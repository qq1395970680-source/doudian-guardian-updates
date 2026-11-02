import {fingerprint} from './policy.mjs';

function matchingState(proof,shopId,productId,now){return proof?.complete===true&&proof.shopId===shopId&&proof.productId===productId&&Number.isFinite(proof.observedAt)&&proof.observedAt>0&&proof.observedAt<=now+5000;}
export function explicitOnShelfState({shopId,productId,check,now=Date.now()}){
 const proof=check?.productState;return check?.shopId===shopId&&check.productId===productId&&matchingState(proof,shopId,productId,now)&&now-proof.observedAt<=120000&&proof.source==='live-platform-product-management'&&proof.kind==='managed-product-state'&&proof.status==='售卖中'?proof:null;
}
// This is display history, not a current eligibility or recovery proof.
export function lastInactiveProductEvidence({shopId,productId,check,now=Date.now()}){
 if(check?.shopId!==shopId||check.productId!==productId)return null;
 const candidates=[check,check.lastKnownInactive].filter(candidate=>{
  const proof=candidate?.productState;if(!matchingState(proof,shopId,productId,now))return false;
  return candidate.code==='OFF_SHELF'&&proof.source==='live-platform-product-management'&&proof.kind==='off-shelf'&&proof.status==='已下架'||candidate.code==='PRODUCT_RECYCLED'&&proof.source==='live-platform-product-recycle'&&proof.kind==='recycled';
 }).sort((a,b)=>b.productState.observedAt-a.productState.observedAt);
 const latest=candidates[0],onShelf=explicitOnShelfState({shopId,productId,check,now});
 return latest&&(!onShelf||onShelf.observedAt<latest.productState.observedAt)?latest:null;
}

// Presentation preference only. Retain the last independently verified removal
// even after freshness expires; this never supplies execution evidence/consent.
export function hiddenInactiveProductIds({shopId,checks=[],catalog,now=Date.now()}){
 const products=new Map((catalog?.products||[]).map(p=>[p.productId,p]));
 return [...new Set(checks.filter(check=>{
  const evidence=lastInactiveProductEvidence({shopId,productId:check.productId,check,now}),p=products.get(check.productId);
  if(!evidence)return false;
  if(p&&(p.current.length||p.scheduled.length||p.pending||p.ambiguous))return false;
  return true;
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
