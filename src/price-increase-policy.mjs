import {randomUUID} from 'node:crypto';
import {id,requireThat,fingerprint} from './policy.mjs';
import {combinePriceConstraints,selectClosestPriceStep} from './price-constraints.mjs';

const source='human-app-price-increase-consent';
const currentKey=shopId=>'price-increase-policy:'+id(shopId);
const grantKey=(shopId,grantId)=>'price-increase-grant:'+id(shopId)+':'+grantId;
function validGrant(grant,shopId,now){return grant?.schema===1&&grant.shopId===shopId&&grant.source===source&&grant.mode==='nearest-explicit-floor-no-reductions'&&
 grant.allowMatchedRisk===true&&grant.continueGuardingExactPrices===true&&typeof grant.id==='string'&&Number.isFinite(grant.at)&&grant.at>0&&grant.at<=now;}

export function activePriceIncreaseGrant(journal,shopId,now=Date.now()){
 if(!shopId)return null;const current=journal.settings(currentKey(shopId));
 if(current?.enabled!==true||!current.grantId)return null;
 const grant=journal.settings(grantKey(shopId,current.grantId));return validGrant(grant,shopId,now)?grant:null;
}
export function setPriceIncreasePolicy(journal,shopId,{enabled,acceptHigherPricesAndRisk=false}={},now=Date.now()){
 id(shopId);requireThat(journal.settings('application')?.accounts?.some(a=>a.shopId===shopId),'ACCOUNT_UNKNOWN','请先登录这家店铺');
 requireThat(typeof enabled==='boolean','PRICE_INCREASE_CONSENT_REQUIRED','自动提价设置无效');
 requireThat(!enabled||acceptHigherPricesAndRisk===true,'PRICE_INCREASE_CONSENT_REQUIRED','请明确确认本店自动提价及对应风险提示的规则');
 return journal.transaction(()=>{
  let grant=activePriceIncreaseGrant(journal,shopId,now);
  if(enabled&&!grant){grant={schema:1,id:randomUUID(),shopId,source,mode:'nearest-explicit-floor-no-reductions',allowMatchedRisk:true,continueGuardingExactPrices:true,at:now};
   journal.putSettings(grantKey(shopId,grant.id),grant);
  }
  const current={schema:1,shopId,enabled,grantId:grant?.id||journal.settings(currentKey(shopId))?.grantId||null,updatedAt:now};
  journal.putSettings(currentKey(shopId),current);journal.event(null,enabled?'automatic-price-increase-enabled':'automatic-price-increase-disabled',{shopId,grantId:current.grantId},now);
  return current;
 });
}

// Recompute every target from its own observed numeric constraints. A single
// lower step, unknown statement, or gratuitous increase requires human review.
export function isAutomaticPriceIncrease(review){
 try{
  if(review?.source!=='live-platform-draft'||review.kind==='sku-price-ratio'||!Array.isArray(review.rows)||!review.rows.length)return false;
  let higher=false;const ids=new Set();
  for(const row of review.rows){
   if(ids.has(row.id))return false;ids.add(row.id);
   const bounds=combinePriceConstraints(row.evidence),selected=selectClosestPriceStep({baseFen:row.baseFen,discount:row.previousDiscount},bounds);
   if(fingerprint(bounds)!==fingerprint(row.bounds)||selected.discount!==row.discount||selected.saleFen!==row.saleFen||selected.previousFen!==row.previousFen||row.discount<row.previousDiscount)return false;
   if(row.discount>row.previousDiscount){if(bounds.minFen==null&&bounds.minDiscount==null)return false;higher=true;}
  }
  return higher;
 }catch{return false;}
}

export function validAutomaticPriceApproval(journal,review){
 if(review?.approvalKind!=='automatic-price-increase'||review.status!=='approved'||!review.automaticConsent?.grantId)return false;
 const grant=journal.settings(grantKey(review.shopId,review.automaticConsent.grantId));
 return validGrant(grant,review.shopId,review.approvedAt)&&review.automaticConsent.targetsFingerprint===fingerprint(review.rows)&&
  review.automaticConsent.continueGuardingExactPrices===true&&isAutomaticPriceIncrease(review);
}
