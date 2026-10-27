import {randomUUID} from 'node:crypto';
import {id,fingerprint,requireThat,validateHistorical} from './policy.mjs';
import {validCurrentAbsence} from './rebuild-review.mjs';

const key=shopId=>'original-rebuild-policy:'+id(shopId);
const source='human-app-original-rebuild-consent';
export function activeOriginalRebuildGrant(journal,shopId,now=Date.now()){
 if(typeof journal?.settings!=='function'||!shopId)return null;
 const value=journal.settings(key(shopId));
 return value?.schema===1&&value.enabled===true&&value.shopId===shopId&&value.source===source&&
  value.mode==='saved-prices-and-activity-rules'&&value.keepSoldOutProtection===true&&value.at>0&&value.at<=now&&
  typeof value.id==='string'&&value.key===fingerprint({...value,key:undefined})?value:null;
}
export function setOriginalRebuildPolicy(journal,shopId,{enabled,acceptOriginalRebuild=false}={},now=Date.now()){
 id(shopId);
 requireThat(journal.settings('application')?.accounts?.some(a=>a.shopId===shopId&&a.originalRiskAllowed===true),
  'ORIGINAL_REBUILD_CONSENT_REQUIRED','请先确认本店原折扣守护规则');
 requireThat(typeof enabled==='boolean'&&(!enabled||acceptOriginalRebuild===true),'ORIGINAL_REBUILD_CONSENT_REQUIRED','请确认本店按已保存价格、时长及活动额度自动重新创建的规则');
 return journal.transaction(()=>{
  const previous=activeOriginalRebuildGrant(journal,shopId,now);
  const material={schema:1,id:previous?.id||randomUUID(),shopId,source,enabled,mode:'saved-prices-and-activity-rules',keepSoldOutProtection:true,at:now};
  const value={...material,key:fingerprint(material)};
  journal.putSettings(key(shopId),value);journal.event(null,enabled?'original-rebuild-enabled':'original-rebuild-disabled',{shopId,grantId:value.id},now);
  return value;
 });
}
// This is explicit authorization to recreate saved terms, never evidence of an
// abnormal platform removal. A new quantity still cannot override known sellout,
// cancellation, ambiguous state or an unverified platform price restriction.
export function authorizedOriginalContinuity(journal,baseline,detail,now=Date.now()){
 const grant=activeOriginalRebuildGrant(journal,baseline.shopId,now);
 if(!grant||!['reference-missing','risk-removal-unproven','auto-renew-or-duration-unproven','expired-member-unproven'].includes(detail?.branch)||
  !validCurrentAbsence(detail.currentAbsence,baseline.shopId,baseline.productId,now)||
  detail.soldOut===true||detail.status==='已作废')return null;
 if(detail.risk===true&&(!detail.export?.present||!detail.export.complete||!detail.export.shopMatched||!detail.export.campaignMatched||
  !Number.isFinite(detail.export.observedAt)||now-detail.export.observedAt>120000||detail.export.observedAt>now+5000))return null;
 validateHistorical(baseline);
 if(detail.branch==='reference-missing'){
  const lookup=detail.referenceLookup;
  if(lookup?.complete!==true||lookup.campaignId!==detail.referenceCampaignId||!Array.isArray(lookup.matchingIds)||lookup.matchingIds.length||
   !Number.isFinite(lookup.observedAt)||now-lookup.observedAt>120000||lookup.observedAt>now+5000)return null;
 }else if(detail.detailComplete!==true||!Number.isFinite(detail.detailObservedAt)||now-detail.detailObservedAt>120000||detail.detailObservedAt>now+5000)return null;
 return{...structuredClone(detail),kind:'authorized-original-rebuild',branch:'eligible-by-shop-original-rebuild-consent',
  grantId:grant.id,grantKey:grant.key,historicalFingerprint:fingerprint(baseline)};
}
export function assertOriginalRebuildConsent(journal,task,now=Date.now()){
 for(const item of task.lossEvidence?.continuities||[]){
  if(item.kind!=='authorized-original-rebuild')continue;
  const grant=activeOriginalRebuildGrant(journal,task.shopId,now),plan=task.plans.find(p=>p.productId===item.productId);
  requireThat(grant&&grant.id===item.grantId&&grant.key===item.grantKey&&plan?.historicalFingerprint===item.historicalFingerprint,
   'ORIGINAL_REBUILD_CONSENT_CHANGED','本店自动重新创建规则已变化，须重新核验；未使用过期授权提交');
 }
}
