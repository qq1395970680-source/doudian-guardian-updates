import {fingerprint,normalizeName,requireThat,saleFen} from './policy.mjs';
import {campaignChoice} from './campaign-choice.mjs';
import {hasExactPriceConsent} from './original-price-recovery-policy.mjs';
const material=r=>({shopId:r.shopId,productId:r.productId,historicalFingerprint:r.historicalFingerprint,
 previousApprovalId:r.previousApprovalId,previousHistoricalFingerprint:r.previousHistoricalFingerprint,
 previousRowsFingerprint:r.previousRowsFingerprint,kind:r.kind,source:r.source,type:r.type,rules:r.rules,
 campaignTarget:r.campaignTarget,skippedSkuIds:r.skippedSkuIds,rows:r.rows});
export function makeHistoryReconfirmation(plan,previous,now=Date.now()){
 requireThat(previous?.status==='approved'&&previous.shopId===plan.shopId&&previous.productId===plan.productId&&
  previous.historicalFingerprint!==plan.historicalFingerprint&&previous.campaignTarget&&
  hasExactPriceConsent(previous),
  'PRICE_SOURCE_CHANGED','旧方案的确切批准或活动类型无法核实，请先核对历史来源');
 requireThat(plan.observedAt>0&&now-plan.observedAt<=120000&&plan.observedAt<=now+5000,'STALE_OR_INCOMPLETE','须先完整读取当前规格');
 const target=campaignChoice(previous.campaignTarget.type);
 requireThat(fingerprint(target)===fingerprint(previous.campaignTarget),'CAMPAIGN_CHOICE_CHANGED','旧活动类型或规则不是明确批准的方案');
 const rows=plan.skus.map(sku=>{
  const matches=previous.rows.filter(r=>r.id===sku.id),old=matches[0];
  requireThat(matches.length===1&&old.name===normalizeName(sku.name)&&old.baseFen===sku.baseFen&&
   old.saleFen===saleFen(old.baseFen,old.discount),'PRICE_SOURCE_CHANGED','规格或原价已变化，不能直接沿用旧确认目标');
  return{id:sku.id,name:sku.name,baseFen:sku.baseFen,historicalDiscount:sku.discount,previousDiscount:sku.discount,
   previousFen:sku.saleFen,discount:old.discount,saleFen:old.saleFen,bounds:{},
   evidence:['历史来源发生变化：左侧为本次历史价格，右侧为旧确认目标。须重新确认整件商品的价格及活动类型，随后重新核验平台限制。']};
 });
 const value={shopId:plan.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,
  previousApprovalId:previous.id,previousHistoricalFingerprint:previous.historicalFingerprint,previousRowsFingerprint:fingerprint(previous.rows),
  kind:'history-reconfirmation',source:'approved-price-history-recheck',type:target.type,rules:target.rules,campaignTarget:target,
  skippedSkuIds:[...plan.skippedSkuIds],rows};
 return{...value,key:fingerprint(material(value)),taskId:null,createdAt:now,expiresAt:now+30*60000,status:'pending'};
}
export function assertHistoryReconfirmation(review,previous,baseline){
 requireThat(review.source==='approved-price-history-recheck'&&review.kind==='history-reconfirmation'&&review.key===fingerprint(material(review))&&
  previous?.status==='approved'&&previous.id===review.previousApprovalId&&previous.shopId===review.shopId&&previous.productId===review.productId&&
  previous.historicalFingerprint===review.previousHistoricalFingerprint&&fingerprint(previous.rows)===review.previousRowsFingerprint&&
  baseline?.shopId===review.shopId&&baseline.productId===review.productId&&fingerprint(baseline)===review.historicalFingerprint&&
  fingerprint(previous.campaignTarget)===fingerprint(review.campaignTarget)&&fingerprint(campaignChoice(review.type))===fingerprint(review.campaignTarget)&&
  fingerprint(review.rules)===fingerprint(review.campaignTarget.rules)&&review.rows.length>0&&new Set(review.rows.map(r=>r.id)).size===review.rows.length&&
  review.rows.every(row=>{
   const h=baseline.skus.find(s=>s.id===row.id),old=previous.rows.find(s=>s.id===row.id);
   return h&&old&&row.name===normalizeName(h.name)&&row.name===old.name&&row.baseFen===h.baseFen&&row.baseFen===old.baseFen&&
    row.historicalDiscount===h.discount&&row.previousDiscount===h.discount&&row.previousFen===saleFen(h.baseFen,h.discount)&&
    row.discount===old.discount&&row.saleFen===old.saleFen&&row.saleFen===saleFen(row.baseFen,row.discount);
  }),'PRICE_REVIEW_CHANGED','新旧历史、确切价格或活动方案已经变化，请重新核对');
}
