import {fingerprint,normalizeName,requireThat,saleFen,proveDraft,priceMode,priceModeFields,expectedSaleFen,assertSamePriceMode} from './policy.mjs';
import {combinePriceConstraints,selectClosestPriceStep} from './price-constraints.mjs';
import {validateRemovalPriceEvidence,selectRatioPrices,describeRatio} from './ratio-prices.mjs';
export {parsePriceConstraint,combinePriceConstraints,selectClosestPriceStep} from './price-constraints.mjs';

// A necessary reduction is narrower than a complete feasible price proposal.
// Keep explicit, bound SKU caps even when a separate grouped ratio is unclear.
// No candidate or approval is produced by this proof.
export function makeNecessaryReductionEvidence(task,probe,now=Date.now()){
 requireThat(task?.plans?.length===1&&probe?.source==='live-platform-draft'&&probe.kind==='draft'&&probe.dialogs?.length===0&&
  Number.isFinite(probe.observedAt)&&probe.observedAt>0&&probe.observedAt<=now&&now-probe.observedAt<=120000,
  'PRICE_REVIEW_EVIDENCE','必要降价依据须来自本次完整且新鲜的独立草稿');
 proveDraft(task,{...probe,warnings:[]},probe.observedAt);
 const errors=new Set(probe.rows.flatMap(r=>r.errors||[]));
 requireThat(errors.size>0&&(probe.warnings||[]).every(w=>errors.has(w)),'PRICE_RULE_UNKNOWN','不能将无法对应具体规格的提示作为必须降价证明');
 const plan=task.plans[0],required=[];
 for(const sku of plan.skus){
  const row=probe.rows.find(r=>r.productId===plan.productId&&r.id===sku.id),statements=[...(row.errors||[])],bounds=combinePriceConstraints(statements);
  selectClosestPriceStep({...sku,...priceModeFields(plan)},bounds); // Reject contradictory or impossible caps.
  if(bounds.maxFen==null&&bounds.maxDiscount==null)continue;
  const prices=[];if(priceMode(plan)==='fixed')prices.push(Math.min(sku.baseFen,bounds.maxFen??sku.baseFen));else for(let d=10;d<=95;d++){const price=saleFen(sku.baseFen,d);
   if(d>=(bounds.minDiscount??10)&&d<=(bounds.maxDiscount??95)&&price>0&&price>=(bounds.minFen??1)&&price<=(bounds.maxFen??Infinity))prices.push(price);}
  const maximumExplicitPriceFen=Math.max(...prices);
  if(maximumExplicitPriceFen<sku.saleFen)required.push({id:sku.id,name:normalizeName(sku.name),baseFen:sku.baseFen,guardedDiscount:sku.discount,guardedFen:sku.saleFen,
   maximumExplicitPriceFen,minimumReductionFen:sku.saleFen-maximumExplicitPriceFen,bounds,statements});
 }
 if(!required.length)return null;
 return {...priceModeFields(plan),source:'live-platform-necessary-sku-reduction',shopId:plan.shopId,productId:plan.productId,activityType:plan.type,historicalFingerprint:plan.historicalFingerprint,
  previousApprovalId:plan.priceApprovalId||null,taskId:task.id,observedAt:probe.observedAt,probeFingerprint:fingerprint(probe),allSkuIds:plan.skus.map(s=>s.id),rows:required};
}

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
    const sourceLosses=(task.lossEvidence?.priceRules||[]).filter(l=>l.removal?.productId===plan.productId&&
      (!l.removalEvidence?.activityType||l.removalEvidence.activityType===plan.type));
    requireThat(sourceLosses.length<=1,'PRICE_REVIEW_EVIDENCE','商品倍率来源重复');
    const sourceLoss=sourceLosses[0],ratio=sourceLoss?validateRemovalPriceEvidence(plan,sourceLoss,now):null;
    const statements=plan.skus.map(sku=>[...(probe.rows.find(r=>r.productId===plan.productId&&r.id===sku.id).errors||[])]);
    const limits=statements.map(combinePriceConstraints);
    const joint=ratio?selectRatioPrices(plan.skus.map(s=>({...s,...priceModeFields(plan)})),ratio,limits):null;
    const rows=plan.skus.map((sku,i)=>{
      const evidence=statements[i],bounds=limits[i];
      let discount,price;
      try{({discount,saleFen:price}=joint?joint[i]:selectClosestPriceStep({...sku,...priceModeFields(plan)},bounds));}catch(error){error.message=`${sku.name}：${error.message}`;throw error;}
      if(priceMode(plan)==='fixed'?price<sku.saleFen:discount<sku.discount)requireThat(ratio||bounds.maxFen!=null||bounds.maxDiscount!=null,'PRICE_BOUND_UNKNOWN','缺少明确价格上限');
      if(priceMode(plan)==='fixed'?price>sku.saleFen:discount>sku.discount)requireThat(ratio||bounds.minFen!=null||bounds.minDiscount!=null,'PRICE_BOUND_UNKNOWN','缺少明确价格下限');
      return {id:sku.id,name:normalizeName(sku.name),baseFen:sku.baseFen,historicalDiscount:sku.originalDiscount??sku.discount,
        previousDiscount:sku.discount,previousFen:sku.saleFen,discount,saleFen:price,bounds,
        evidence:ratio?[...evidence,sourceLoss.removal.reason]:evidence};
    });
    if(!rows.some(r=>priceMode(plan)==='fixed'?r.saleFen!==r.previousFen:r.discount!==r.previousDiscount))continue;
    const value={...priceModeFields(plan),shopId:task.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,
      previousApprovalId:plan.priceApprovalId||null,type:plan.type,rules:structuredClone(plan.rules),skippedSkuIds:[...plan.skippedSkuIds],rows,
      ...(plan.campaignTarget?{campaignTarget:structuredClone(plan.campaignTarget)}:{}),
      ...(ratio?{kind:'sku-price-ratio',ratio:describeRatio(plan.skus,rows,ratio)}:{})};
    reviews.push({...value,key:fingerprint(value),source:'live-platform-draft',taskId:task.id,createdAt:now,expiresAt:now+30*60000,status:'pending'});
  }
  requireThat(reviews.length,'PRICE_RULE_UNKNOWN','当前提示未得到明确的调价建议');
  return reviews;
}

// The immutable platform history is never rewritten. An approval is a separate
// exact target, valid only for the same historical source and matching SKUs.
export function applyPriceTarget(original,review) {
  if(!review||review.status!=='approved'||review.shopId!==original.shopId||review.productId!==original.productId||review.historicalFingerprint!==original.historicalFingerprint)return original;
  assertSamePriceMode(original,review);
  const {fingerprint:oldFingerprint,...base}=original;
  let changed=false;
  const skus=original.skus.map(sku=>{
    const row=review.rows.find(r=>r.id===sku.id);
    requireThat(row||review.kind!=='rounding-reconfirmation','PRICE_APPROVAL_CHANGED','此规格未包含在新的金额确认中，需要重新核对，不能回退到历史价格');
    if(!row)return sku;
    const historicalDiscount=sku.originalDiscount??sku.discount;
    requireThat(row.name===normalizeName(sku.name)&&row.baseFen===sku.baseFen&&row.historicalDiscount===historicalDiscount&&
      (priceMode(original)==='fixed'?row.discount===null:Number.isInteger(row.discount)&&row.discount>=10&&row.discount<=95)&&row.saleFen===expectedSaleFen({...sku,...row},original),
      'PRICE_APPROVAL_CHANGED','已确认价格与当前规格或历史发生变化');
    changed=changed||row.discount!==sku.discount||row.saleFen!==sku.saleFen||review.kind==='rounding-reconfirmation';
    return {...sku,...(priceMode(original)==='fixed'?{originalSaleFen:sku.originalSaleFen??sku.saleFen}:{}),originalDiscount:historicalDiscount,discount:row.discount,saleFen:row.saleFen};
  });
  // Retain the previous approval identity even when its changed SKU is absent.
  // Any further proposal must still be linked to the target the human saw.
  const result={...base,skus,originalRiskAllowed:changed?false:original.originalRiskAllowed,approvedRiskAllowed:changed||original.approvedRiskAllowed===true,priceApprovalId:review.id,priceApprovalKey:review.key};
  return {...result,fingerprint:fingerprint(result)};
}

