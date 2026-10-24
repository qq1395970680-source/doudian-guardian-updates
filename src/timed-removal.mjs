import {GuardError,isLimited} from './policy.mjs';

// Only the exact latest verified timed source may constrain its next restore.
// A rejected ancestor must never override a newer active/restored activity.
export function timedRemovalEvidence({baseline,reference,listing,details,shopId,now=Date.now()}){
 const campaign=listing.campaigns.find(c=>c.id===reference.campaignId);
 if(!campaign||isLimited(campaign)||campaign.risk!==true||!['进行中','未开始','已失效','已结束'].includes(campaign.status))return{};
 const detail=details.get(campaign.id),source=detail?.removalExport;
 const fail=(code,branch,message)=>{throw new GuardError(code,message,{productId:baseline.productId,campaignId:campaign.id,
  timedLoss:{branch,productId:baseline.productId,referenceCampaignId:campaign.id,status:campaign.status,
   detailObservedAt:detail?.observedAt??null,exportObservedAt:source?.observedAt??null,
   exportError:detail?.removalExportError??null,nextAction:'重新核对本商品对应限时活动的退出明细，保留价格确认，未重复创建'}});};
 const fresh=at=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
 if(listing.complete!==true||detail?.complete!==true||source?.source!=='live-platform-removal-export'||source.complete!==true||
  source.shopId!==shopId||source.campaignId!==campaign.id||!/^[a-f0-9]{64}$/.test(source.sha256)||!Array.isArray(source.records))
  return fail('TIMED_LOSS_UNPROVEN','export-unproven','对应限时活动存在异常退出，但退出明细未完整核对，暂停该商品恢复');
 if(!fresh(listing.observedAt)||!fresh(detail.observedAt)||!fresh(source.observedAt))
  return fail('LOSS_EVIDENCE_EXPIRED','export-stale','对应限时活动退出证据已过期，需要批量重新核对');
 const matches=source.records.filter(r=>r.productId===baseline.productId);
 if(matches.length>1)return fail('TIMED_LOSS_UNPROVEN','duplicate-product','限时活动退出明细存在重复商品编号，暂停该商品恢复');
 if(!matches.length)return{};
 const record=structuredClone(matches[0]);
 return{removal:record,removalEvidence:{source:source.source,complete:true,shopId:source.shopId,campaignId:source.campaignId,
  activityType:campaign.type,observedAt:source.observedAt,sha256:source.sha256,record:structuredClone(record)}};
}
