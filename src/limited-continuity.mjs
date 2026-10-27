import {GuardError,isLimited} from './policy.mjs';

const current=c=>['进行中','未开始'].includes(c?.status);
const fresh=(at,now)=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
const matchedExport=(shopId,productId,c,d)=>{
 const source=d?.removalExport,records=source?.records;
 return d?.complete===true&&source?.source==='live-platform-removal-export'&&source.complete===true&&
  source.shopId===shopId&&source.campaignId===c.id&&Array.isArray(records)&&records.filter(r=>r.productId===productId).length===1;
};

// An exact exported product ID can identify its current source independently
// of an older baseline. Names/timestamps never establish renewal lineage.
// An aged export is a lookup hint only; resolveLimitedLoss checks freshness.
export function currentLimitedReference(base,baseline,listing,details,shopId){
 if(!base.limited||!listing?.complete||!(details instanceof Map))return base;
 const matches=(listing.campaigns||[]).filter(c=>isLimited(c)&&current(c)&&c.risk===true&&
  matchedExport(shopId,baseline.productId,c,details.get(c.id)));
 if(matches.length>1)throw new GuardError('LIMITED_LOSS_UNPROVEN','商品同时出现在多个当前活动退出表，需重新核对来源，未重复创建',
  {limitedLoss:{branch:'multiple-current-removal-sources',productId:baseline.productId,historicalCampaignId:baseline.campaignId,
   candidateCampaignIds:matches.map(c=>c.id),nextAction:'重新核对当前活动及商品归属'}});
 if(!matches.length)return base;
 return{...base,campaignId:matches[0].id,title:matches[0].name,referenceSource:'current-exact-product-removal-export'};
}

export function resolveLimitedLoss({baseline,reference,listing,details,shopId,now=Date.now()}){
 const c=listing.campaigns.find(c=>c.id===reference.campaignId),d=details.get(reference.campaignId);
 const p=d?.products.find(p=>p.productId===baseline.productId),source=d?.removalExport;
 const matched=!!c&&matchedExport(shopId,baseline.productId,c,d),record=matched?source.records.find(r=>r.productId===baseline.productId):null;
 const sourceFresh=matched&&fresh(source.observedAt,now);
 const ended=!!c&&['已结束','已失效'].includes(c.status)&&Number.isFinite(c.startAt)&&c.startAt>0&&
  Number.isFinite(c.endAt)&&c.endAt>c.startAt&&c.endAt<=now;
 const renew=ended&&isLimited(c)&&reference.rules?.autoRenew===true&&d?.rules?.autoRenew===true&&
  Number.isSafeInteger(reference.durationMs)&&reference.durationMs>0&&c.endAt-c.startAt===reference.durationMs;
 const proof={productId:baseline.productId,historicalCampaignId:baseline.campaignId,referenceCampaignId:reference.campaignId,
  referenceSource:reference.referenceSource||'last-verified-or-historical-source',status:c?.status??null,startAt:c?.startAt??null,endAt:c?.endAt??null,
  autoRenew:reference.rules?.autoRenew??null,risk:c?.risk===true,detailComplete:d?.complete===true,detailObservedAt:d?.observedAt??null,
  memberPresent:!!p,soldOut:p?.soldOut??null,removalConfirmed:p?.removalConfirmed??null,removalRiskConfirmed:p?.removalRiskConfirmed??null,
  export:{present:!!source,source:source?.source??null,complete:source?.complete===true,observedAt:source?.observedAt??null,
   shopMatched:source?.shopId===shopId,campaignMatched:source?.campaignId===reference.campaignId,productMatched:matched,fresh:!!sourceFresh},
  nextAction:'重新读取对应平台活动和完整商品状态后再核验；尚未入队或提交'};
 const fail=(branch,message)=>{throw new GuardError('LIMITED_LOSS_UNPROVEN',message,{limitedLoss:{...proof,branch}});};
 if(!c)return fail('reference-missing','尚未找到对应限量活动，需重新核对旧活动或新一期商品退出来源');
 if(c.status==='已作废')return fail('source-cancelled','原活动已作废，不自动重建；历史折扣保留');
 if(p?.soldOut===true)return fail('sold-out','商品活动限量已售罄，不自动补量；历史折扣保留');
 if(d?.complete!==true)return fail('detail-incomplete','对应限量活动详情尚未完整读取，暂停恢复');
 if(p?.removalAmbiguous)return fail('product-state-ambiguous','商品是否已退出活动仍不明确，暂停恢复');
 const activeExport=sourceFresh&&c.risk===true&&c.endAt>now&&['进行中','未开始','已失效'].includes(c.status);
 const expiredExport=sourceFresh&&renew&&fresh(d.observedAt,now);
 if(activeExport||expiredExport){
  const removalEvidence={source:source.source,complete:true,shopId:source.shopId,campaignId:source.campaignId,activityType:c.type,
   observedAt:source.observedAt,sha256:source.sha256,record:structuredClone(record)};
  return{removal:record,removalEvidence,continuity:{...proof,kind:expiredExport?'expired-risk-renewal':'risk-removal',branch:'eligible'}};
 }
 // Preserve existing exact row-level risk evidence, while rejecting cancelled
 // and sold-out sources before this branch. Old tests/older row snapshots may
 // lack timing; a natural expiry always needs the stronger renewal proof.
 if(p?.removalConfirmed===true&&p.removalRiskConfirmed===true&&(!ended||renew))
  return{continuity:{...proof,kind:ended?'expired-risk-renewal':'risk-removal',branch:'eligible'}};
 if(renew&&fresh(d.observedAt,now)&&p&&p.soldOut===false&&p.removalConfirmed===false&&p.removalAmbiguous===false&&
  p.activityLimit===reference.activityLimit)
  return{continuity:{...proof,kind:'expired-renewal',branch:'eligible'}};
 if(matched&&!sourceFresh)return fail('removal-export-stale','已找到本商品退出记录，但读取已过期，需重新核对当前平台退出表');
 if(ended&&!renew)return fail('auto-renew-or-duration-unproven','原活动已到期，但自动续期或确切时长尚未核对，不自动补量');
 if(ended&&!p)return fail('expired-member-unproven','原活动已到期，尚无本商品正常参与或异常退出的完整证明，需重新核对');
 return fail('risk-removal-unproven','尚无本商品异常退出或可续守到期的明确证明；售罄和不明消失不自动补量');
}
