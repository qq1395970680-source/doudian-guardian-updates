import {fingerprint,normalizeName,requireThat,restorationDuration,isLimited} from './policy.mjs';
export const rebuildMaterial=plan=>({type:plan.type,rules:structuredClone(plan.rules),durationMs:restorationDuration(plan),
 ...(isLimited(plan)?{activityLimit:plan.activityLimit}:{})});
export const rebuildSourceBinding=detail=>({referenceCampaignId:detail.referenceCampaignId,status:detail.status??null,
 startAt:detail.startAt??null,endAt:detail.endAt??null,branch:detail.branch});
export function validCurrentAbsence(proof,shopId,productId,now=Date.now()){
 return proof?.source==='live-platform-current-absence'&&proof.complete===true&&proof.shopId===shopId&&proof.productId===productId&&
  Number.isFinite(proof.observedAt)&&proof.observedAt>0&&proof.observedAt<=now+5000&&now-proof.observedAt<=120000&&/^[a-f0-9]{64}$/.test(proof.listingFingerprint);
}
export function makeRebuildReview(plan,detail,now=Date.now()){
 const {fingerprint:hash,...material}=plan;
 requireThat(hash===fingerprint(material)&&validCurrentAbsence(detail?.currentAbsence,plan.shopId,plan.productId,now)&&
  plan.observedAt>0&&now-plan.observedAt<=120000&&plan.observedAt<=now+5000&&typeof detail.referenceCampaignId==='string',
  'REBUILD_REVIEW_EVIDENCE','重新建活动确认需要本轮完整活动缺失和当前规格证明');
 const value={kind:'limited-rebuild',shopId:plan.shopId,productId:plan.productId,name:plan.name,
  historicalFingerprint:plan.historicalFingerprint,previousApprovalId:plan.priceApprovalId||null,type:plan.type,rules:structuredClone(plan.rules),
  durationMs:restorationDuration(plan),...(isLimited(plan)?{activityLimit:plan.activityLimit}:{}),skippedSkuIds:[...plan.skippedSkuIds],
  rebuildTarget:rebuildMaterial(plan),rebuildSource:rebuildSourceBinding(detail),
  rows:plan.skus.map(s=>({id:s.id,name:normalizeName(s.name),baseFen:s.baseFen,historicalDiscount:s.originalDiscount??s.discount,
   previousDiscount:s.discount,previousFen:s.saleFen,discount:s.discount,saleFen:s.saleFen,bounds:{},
   evidence:['当前未读到有效活动，原活动退出原因未被证实；需明确确认重新创建及活动额度。']})),
  ...(plan.campaignTarget?{campaignTarget:structuredClone(plan.campaignTarget)}:{})};
 return{...value,key:fingerprint(value),source:'live-platform-current-absence',taskId:null,sourceProof:structuredClone(detail.currentAbsence),
  sourceDetail:structuredClone(detail),createdAt:now,expiresAt:now+30*60000,status:'pending'};
}
export function confirmedRebuildContinuity(review,baseline,detail,now=Date.now()){
 if(review?.kind!=='limited-rebuild'||review.status!=='approved'||review.consent?.rebuildConfirmed!==true||
  review.shopId!==baseline.shopId||review.productId!==baseline.productId||review.historicalFingerprint!==fingerprint(baseline)||
  fingerprint(review.rebuildSource)!==fingerprint(rebuildSourceBinding(detail))||
  !validCurrentAbsence(detail.currentAbsence,baseline.shopId,baseline.productId,now))return null;
 return{...detail,kind:'confirmed-rebuild',branch:'eligible-by-exact-rebuild-consent',rebuildApprovalId:review.id,rebuildApprovalKey:review.key};
}
