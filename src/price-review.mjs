import {fingerprint,normalizeName,requireThat,saleFen,proveDraft} from './policy.mjs';
import {combinePriceConstraints,selectClosestPriceStep} from './price-constraints.mjs';
export {parsePriceConstraint,combinePriceConstraints,selectClosestPriceStep} from './price-constraints.mjs';

export function makePriceReviews(task,probe,now=Date.now()) {
  requireThat(probe?.source==='live-platform-draft'&&probe.kind==='draft'&&probe.dialogs?.length===0,
    'PRICE_REVIEW_EVIDENCE','调价建议必须来自本次独立草稿的完整直接读取');
  // Verify that only the already-authorized prices were entered. Never probe
  // changed candidates in the platform before the human confirms the table.
  proveDraft(task,{...probe,warnings:[]},now);
  const errors=new Set(probe.rows.flatMap(r=>r.errors||[]));
  requireThat(errors.size>0&&(probe.warnings||[]).every(w=>errors.has(w)),
    'PRICE_RULE_UNKNOWN','存在未能对应具体规格的平台提示');
  const reviews=[];
  for(const plan of task.plans){
    const rows=plan.skus.map(sku=>{
      const observed=probe.rows.find(r=>r.productId===plan.productId&&r.id===sku.id),evidence=[...(observed.errors||[])],bounds=combinePriceConstraints(evidence);
      let discount;
      try{({discount}=selectClosestPriceStep(sku,bounds));}catch(error){error.message=`${sku.name}：${error.message}`;throw error;}
      if(discount<sku.discount)requireThat(bounds.maxFen!=null||bounds.maxDiscount!=null,'PRICE_BOUND_UNKNOWN','缺少明确价格上限');
      if(discount>sku.discount)requireThat(bounds.minFen!=null||bounds.minDiscount!=null,'PRICE_BOUND_UNKNOWN','缺少明确价格下限');
      return {id:sku.id,name:normalizeName(sku.name),baseFen:sku.baseFen,historicalDiscount:sku.originalDiscount??sku.discount,
        previousDiscount:sku.discount,previousFen:sku.saleFen,discount,saleFen:saleFen(sku.baseFen,discount),bounds,evidence};
    });
    if(!rows.some(r=>r.discount!==r.previousDiscount))continue;
    const value={shopId:task.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,
      previousApprovalId:plan.priceApprovalId||null,type:plan.type,rules:structuredClone(plan.rules),skippedSkuIds:[...plan.skippedSkuIds],rows};
    reviews.push({...value,key:fingerprint(value),source:'live-platform-draft',taskId:task.id,createdAt:now,expiresAt:now+30*60000,status:'pending'});
  }
  requireThat(reviews.length,'PRICE_RULE_UNKNOWN','当前提示未得到明确的调价建议');
  return reviews;
}

// The immutable platform history is never rewritten. An approval is a separate
// exact target, valid only for the same historical source and matching SKUs.
export function applyPriceTarget(original,review) {
  if(!review||review.status!=='approved'||review.shopId!==original.shopId||review.productId!==original.productId||review.historicalFingerprint!==original.historicalFingerprint)return original;
  const {fingerprint:oldFingerprint,...base}=original;
  let changed=false;
  const skus=original.skus.map(sku=>{
    const row=review.rows.find(r=>r.id===sku.id);if(!row)return sku;
    requireThat(row.name===normalizeName(sku.name)&&row.baseFen===sku.baseFen&&row.historicalDiscount===sku.discount&&
      Number.isInteger(row.discount)&&row.discount>=10&&row.discount<=95&&row.saleFen===saleFen(sku.baseFen,row.discount),
      'PRICE_APPROVAL_CHANGED','已确认价格与当前规格或历史发生变化');
    changed=changed||row.discount!==sku.discount;
    return {...sku,originalDiscount:sku.discount,discount:row.discount,saleFen:row.saleFen};
  });
  // Retain the previous approval identity even when its changed SKU is absent.
  // Any further proposal must still be linked to the target the human saw.
  const result={...base,skus,originalRiskAllowed:changed?false:original.originalRiskAllowed,approvedRiskAllowed:changed,priceApprovalId:review.id,priceApprovalKey:review.key};
  return {...result,fingerprint:fingerprint(result)};
}

