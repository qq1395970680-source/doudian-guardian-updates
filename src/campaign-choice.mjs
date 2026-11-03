import {fingerprint,requireThat} from './policy.mjs';
export function campaignChoice(type){
 requireThat(['限量抢购','限时抢购'].includes(type),'CAMPAIGN_CHOICE_INVALID','只支持限量抢购和限时抢购');
 return type==='限量抢购'?{
  type,activityLimit:1000,durationMs:7*86400000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}
 }:{type,activityLimit:null,durationMs:48*3600000,rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30}};
}
export function approvedCampaignChoice(review,plan){
 if(!review?.campaignTarget)return null;
 requireThat(review.status==='approved'&&review.shopId===plan.shopId&&review.productId===plan.productId&&
  review.historicalFingerprint===plan.historicalFingerprint&&(review.consent?.exactPrices===true||
   review.approvalKind==='automatic-price-increase'&&review.automaticConsent?.targetsFingerprint===fingerprint(review.rows)||
   review.approvalKind==='original-price-continuity'&&review.continuityConsent?.targetsFingerprint===fingerprint(review.rows)),
  'CAMPAIGN_CHOICE_CHANGED','商品活动方案未明确确认或历史来源已变化');
 const canonical=campaignChoice(review.campaignTarget.type);
 const prior=review.dualManualSource?.plan,original=prior&&{type:prior.type,rules:prior.rules,durationMs:prior.durationMs??48*3600000,activityLimit:prior.activityLimit??null};
 const retained=review.dualPairKey===review.dualManualSource?.pairKey&&review.consent?.exactPrices===true&&prior?.shopId===plan.shopId&&prior.productId===plan.productId&&prior.historicalFingerprint===plan.historicalFingerprint&&fingerprint(original)===fingerprint(review.campaignTarget);
 requireThat(fingerprint(canonical)===fingerprint(review.campaignTarget)||retained,'CAMPAIGN_CHOICE_CHANGED','商品活动规则与已核对的方案不符');
 return retained?structuredClone(original):canonical;
}
