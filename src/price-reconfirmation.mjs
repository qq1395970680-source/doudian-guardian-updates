import {fingerprint,normalizeName,requireThat,saleFen} from './policy.mjs';

export const needsPriceReconfirmation=review=>review?.status==='approved'&&review.rows.some(row=>row.saleFen!==saleFen(row.baseFen,row.discount));
const material=r=>({shopId:r.shopId,productId:r.productId,historicalFingerprint:r.historicalFingerprint,
 previousApprovalId:r.previousApprovalId,previousRowsFingerprint:r.previousRowsFingerprint,
 kind:r.kind,source:r.source,type:r.type,rules:r.rules,durationMs:r.durationMs??null,activityLimit:r.activityLimit??null,
 campaignTarget:r.campaignTarget??null,skippedSkuIds:r.skippedSkuIds,rows:r.rows});

// This is a new proposal, never a migration of an existing approval. Its
// comparison prices are copied from the immutable approval, not recomputed.
export function makePriceReconfirmation(plan,previous,now=Date.now()){
 requireThat(needsPriceReconfirmation(previous)&&previous.shopId===plan.shopId&&previous.productId===plan.productId&&
  previous.historicalFingerprint===plan.historicalFingerprint,'PRICE_APPROVAL_CHANGED','原确认与当前商品或历史不一致');
 requireThat(plan.observedAt>0&&plan.observedAt<=now+5000&&now-plan.observedAt<=120000,
  'STALE_OR_INCOMPLETE','重新确认价格前需要新鲜的完整规格读取');
 const rows=plan.skus.map(sku=>{
  const matches=previous.rows.filter(r=>r.id===sku.id),row=matches[0];
  requireThat(matches.length===1&&row.name===normalizeName(sku.name)&&row.baseFen===sku.baseFen&&row.historicalDiscount===sku.discount,
   'PRICE_APPROVAL_CHANGED','规格映射、原价或历史折扣变化，不能按取整更新处理');
  requireThat(Number.isInteger(row.discount)&&row.discount>=10&&row.discount<=95&&
   (row.saleFen===saleFen(row.baseFen,row.discount)||row.saleFen===Math.round(row.baseFen*row.discount/100)),
   'PRICE_APPROVAL_CHANGED','旧确认金额不是可识别的旧取整结果');
  return {id:row.id,name:row.name,baseFen:row.baseFen,historicalDiscount:row.historicalDiscount,
   previousDiscount:row.discount,previousFen:row.saleFen,discount:row.discount,saleFen:saleFen(row.baseFen,row.discount),
   bounds:{},evidence:['金额取整规则更新：保留已确认折扣，按平台向上取分重新计算；须重新确认确切金额，随后重新核验平台限制。']};
 });
 requireThat(rows.some(r=>r.previousFen!==r.saleFen),'PRICE_APPROVAL_CHANGED','当前规格没有需要重新确认的取整差异');
 const value={shopId:plan.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,
  previousApprovalId:previous.id,previousRowsFingerprint:fingerprint(previous.rows),kind:'rounding-reconfirmation',source:'approved-price-rounding-recheck',
  type:plan.type,rules:structuredClone(plan.rules),durationMs:plan.durationMs??null,activityLimit:plan.activityLimit??null,
  ...(plan.campaignTarget?{campaignTarget:structuredClone(plan.campaignTarget)}:{}),skippedSkuIds:[...plan.skippedSkuIds],rows};
 return {...value,key:fingerprint(material(value)),taskId:null,createdAt:now,expiresAt:now+30*60000,status:'pending'};
}

export function assertPriceReconfirmation(review,previous){
 requireThat(review.kind==='rounding-reconfirmation'&&review.source==='approved-price-rounding-recheck'&&
  review.key===fingerprint(material(review))&&previous?.status==='approved'&&previous.id===review.previousApprovalId&&
  previous.shopId===review.shopId&&previous.productId===review.productId&&previous.historicalFingerprint===review.historicalFingerprint&&
  fingerprint(previous.rows)===review.previousRowsFingerprint&&review.rows.length>0&&new Set(review.rows.map(r=>r.id)).size===review.rows.length&&
  review.rows.every(row=>{
   const old=previous.rows.find(s=>s.id===row.id);
   return old&&row.name===old.name&&row.baseFen===old.baseFen&&row.historicalDiscount===old.historicalDiscount&&
    row.previousDiscount===old.discount&&row.discount===old.discount&&row.previousFen===old.saleFen&&
    row.saleFen===saleFen(row.baseFen,row.discount);
  }),'PRICE_REVIEW_CHANGED','重新确认的旧金额、新金额或来源已变化，请重新核对');
}
