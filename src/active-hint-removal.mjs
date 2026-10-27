import {GuardError,fingerprint} from './policy.mjs';
import {parseRemovalPriceRatio} from './removal-export.mjs';

// Classification only. A stale picker hint and even an exact removal export
// supply no current SKU prices, create no plan and authorize no submission.
export function priceRemovalAfterActiveHint(proof,baseline,now=Date.now()){
 const loss=proof?.loss,source=loss?.removalEvidence,record=loss?.removal;
 const fresh=at=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
 if(proof?.error||proof?.productId!==baseline?.productId||loss?.complete!==true||loss.active!==false||loss.ambiguous||
  !fresh(loss.observedAt)||!/^\d{3,25}$/.test(baseline?.shopId||'')||!/^\d{3,25}$/.test(baseline?.productId||'')||
  !/^[a-f0-9]{64}$/.test(loss.lossKey||'')||loss.soldOut===true||loss.continuity?.soldOut===true||loss.continuity?.status==='已作废'||
  source?.source!=='live-platform-removal-export'||source.complete!==true||source.shopId!==baseline.shopId||
  !/^\d{3,25}$/.test(source.campaignId||'')||!['限量抢购','限时抢购'].includes(source.activityType)||
  !fresh(source.observedAt)||!/^[a-f0-9]{64}$/.test(source.sha256||'')||record?.productId!==baseline.productId||
  typeof record.reason!=='string'||fingerprint(record)!==fingerprint(source.record))return null;
 let ratio;try{ratio=parseRemovalPriceRatio(record.reason);}catch{return null;}
 const detail={source:source.source,origin:'independent-removal-after-picker-hint',complete:true,
  shopId:baseline.shopId,productId:baseline.productId,campaignId:source.campaignId,activityType:source.activityType,
  observedAt:source.observedAt,checkedAt:now,sha256:source.sha256,record:structuredClone(record),ratio,
  lossKey:loss.lossKey,pricePlanReady:false};
 return new GuardError('SKU_RATIO_REVIEW_REQUIRED',
  `平台${source.activityType}退出明细已确认：最高规格价须在最低价的${ratio.numerator/ratio.denominator}倍以内。选品页仍提示已参与活动，完整当前规格尚待读取；已保留在价格确认中，待核验后生成确切方案，尚未创建活动。`,
  {activeHintRemoval:detail});
}
