import {randomUUID} from 'node:crypto';
import {id,fingerprint,requireThat,priceMode} from './policy.mjs';
import {validAutomaticPriceApproval} from './price-increase-policy.mjs';
const source='human-app-original-price-recovery-consent';
const currentKey=shop=>'original-price-recovery-policy:'+id(shop);
const grantKey=(shop,grant)=>'original-price-recovery-grant:'+id(shop)+':'+grant;
const validGrant=(g,shop,now)=>g?.schema===1&&g.shopId===shop&&g.source===source&&g.mode==='exact-saved-prices-only'&&
 typeof g.id==='string'&&g.at>0&&g.at<=now&&g.key===fingerprint({...g,key:undefined});
export function activeOriginalPriceRecoveryGrant(journal,shop,now=Date.now()){
 if(!shop)return null;const current=journal.settings(currentKey(shop));
 if(current?.enabled!==true||!current.grantId)return null;
 const grant=journal.settings(grantKey(shop,current.grantId));return validGrant(grant,shop,now)?grant:null;
}
export function setOriginalPriceRecoveryPolicy(journal,shop,{enabled,acceptOriginalPricesOnly=false}={},now=Date.now()){
 id(shop);requireThat(journal.settings('application')?.accounts?.some(a=>a.shopId===shop&&a.originalRiskAllowed===true),
  'ORIGINAL_PRICE_CONSENT_REQUIRED','请先确认本店原折扣守护规则');
 requireThat(typeof enabled==='boolean'&&(!enabled||acceptOriginalPricesOnly===true),'ORIGINAL_PRICE_CONSENT_REQUIRED','请确认仅沿用已保存或已确认的原折扣价，任何新价格要求转入恢复受阻');
 return journal.transaction(()=>{
  let grant=activeOriginalPriceRecoveryGrant(journal,shop,now);
  if(enabled&&!grant){const material={schema:1,id:randomUUID(),shopId:shop,source,mode:'exact-saved-prices-only',at:now};
   grant={...material,key:fingerprint(material)};journal.putSettings(grantKey(shop,grant.id),grant);}
  const value={schema:1,shopId:shop,enabled,grantId:grant?.id||journal.settings(currentKey(shop))?.grantId||null,at:now};
  journal.putSettings(currentKey(shop),value);journal.event(null,enabled?'original-price-recovery-enabled':'original-price-recovery-disabled',{shopId:shop,grantId:value.grantId},now);return value;
 });
}
export function hasExactPriceConsent(review){
 return review?.status==='approved'&&(review.consent?.exactPrices===true&&review.consent?.matchedRiskConfirmation===true||
  review.approvalKind==='automatic-price-increase'&&review.automaticConsent?.targetsFingerprint===fingerprint(review.rows)||
  review.approvalKind==='original-price-continuity'&&review.continuityConsent?.targetsFingerprint===fingerprint(review.rows));
}
export function validOriginalPriceApproval(journal,review,seen=new Set()){
 if(review?.approvalKind!=='original-price-continuity'||!hasExactPriceConsent(review)||seen.has(review.id)||seen.size>=1000)return false;
 seen.add(review.id);const consent=review.continuityConsent;
 const grant=journal.settings(grantKey(review.shopId,consent.grantId));
 const previous=journal.priceReview(review.previousApprovalId);
 if(!validGrant(grant,review.shopId,review.approvedAt)||review.approvedAt<grant.at||!previous||previous.id===review.id||
  previous.shopId!==review.shopId||previous.productId!==review.productId||priceMode(previous)!==priceMode(review)||!hasExactPriceConsent(previous)||
  previous.approvedAt>=review.approvedAt||fingerprint(previous.rows)!==review.previousRowsFingerprint||
  fingerprint(previous.campaignTarget)!==fingerprint(review.campaignTarget)||previous.rows.length!==review.rows.length||
  !review.rows.every(row=>previous.rows.some(old=>old.id===row.id&&old.name===row.name&&old.baseFen===row.baseFen&&old.discount===row.discount&&old.saleFen===row.saleFen)))return false;
 return previous.consent?.exactPrices===true&&previous.consent?.matchedRiskConfirmation===true||
  validAutomaticPriceApproval(journal,previous)||validOriginalPriceApproval(journal,previous,seen);
}
