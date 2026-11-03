import {fingerprint,requireThat,saleFen} from './policy.mjs';
import {priceContext,recordedPriceRejections} from './activity-price-evidence.mjs';
import {priceOptions} from './price-options.mjs';
import {manualPriceEditable} from './manual-price-option.mjs';
import {campaignChoice} from './campaign-choice.mjs';
import {selectClosestPriceStep} from './price-constraints.mjs';
import {selectRatioPrices,describeRatio} from './ratio-prices.mjs';

const types=['限时抢购','限量抢购'];
const previousContext=r=>priceContext(r.historicalFingerprint,r.rows.map(row=>({...row,discount:row.previousDiscount,saleFen:row.previousFen})));
const rejections=(review,context)=>recordedPriceRejections({shopId:review.shopId,productId:review.productId,...context});
function alternateSource(review,type,{reviews=[],tasks=[],now=Date.now(),dualDecision=null}={}){
 const dual=dualDecision;
 if(review.dualPairKey){
  if(!dual?.valid||!dual.approvalAllowed||dual.pairKey!==review.dualPairKey)return null;
  const scheme=dual.schemes?.find(s=>s.type===type),source=reviews.find(r=>r.id===scheme?.reviewId);
  if(scheme?.classification!=='reduction-required'||!source||source.dualPairKey!==dual.pairKey||source.status!=='pending'||source.type!==type||source.createdAt>now||source.expiresAt<=now||source.historicalFingerprint!==review.historicalFingerprint||source.rows.length!==review.rows.length||!review.rows.every(row=>source.rows.some(s=>s.id===row.id&&s.name===row.name&&s.baseFen===row.baseFen&&s.previousFen===row.previousFen&&s.previousDiscount===row.previousDiscount&&s.historicalDiscount===row.historicalDiscount)))return null;
  return source;
 }
 const failure=rejections(review,{reviews,tasks,now}).find(f=>f.type===type),source=reviews.find(r=>r.id===failure?.reviewId);
 if(!source||source.createdAt>now||source.expiresAt<=now||!Number.isFinite(source.expiresAt)||!manualPriceEditable(source)||source.type!==type||failure.context!==previousContext(review))return null;
 if(source.historicalFingerprint!==review.historicalFingerprint||source.rows.length!==review.rows.length||!review.rows.every(row=>source.rows.some(s=>s.id===row.id&&s.name===row.name&&s.baseFen===row.baseFen&&s.historicalDiscount===row.historicalDiscount)))return null;
 return source;
}

// Rebase only independently recorded, fresh constraints for this exact type,
// history, SKU set and previous prices. The other type's caps never leak here.
export function activityPriceBasis(review,type,context={}){
 requireThat(types.includes(type),'CAMPAIGN_CHOICE_INVALID','只支持限时抢购和限量抢购');
 if(type===review.type)return review;
 requireThat(manualPriceEditable(review),'PRICE_REVIEW_CHANGED','请先完成历史、金额或活动重建的专门核对');
 const source=alternateSource(review,type,context);
 requireThat(source,'PRICE_BASIS_REQUIRED','尚无本方案匹配且有效的价格依据；请先按原折扣确认核验该活动，不能套用另一方案的价格限制');
 const {ratio:oldRatio,originalUnavailable:oldUnavailable,campaignTarget:oldTarget,kind:oldKind,...base}=review;
 const skus=review.rows.map(row=>({...row,discount:row.previousDiscount,saleFen:row.previousFen}));
 const bounds=review.rows.map(row=>structuredClone(source.rows.find(s=>s.id===row.id).bounds||{}));
 let selected,originalUnavailable=null;
 try{selected=source.ratio?selectRatioPrices(skus,source.ratio,bounds):skus.map((s,i)=>selectClosestPriceStep(s,bounds[i]));}
 catch(error){if(error.code!=='NO_FEASIBLE_PRICE')throw error;originalUnavailable={code:error.code,message:error.message};selected=skus;}
 const rows=review.rows.map((row,i)=>({...row,bounds:bounds[i],evidence:structuredClone(source.rows.find(s=>s.id===row.id).evidence||[]),discount:selected[i].discount,saleFen:saleFen(row.baseFen,selected[i].discount)}));
 const target=review.dualPairKey?source.campaignTarget||{type:source.type,rules:structuredClone(source.rules),durationMs:source.durationMs,activityLimit:source.activityLimit??null}:campaignChoice(type);
 return {...base,type,rules:structuredClone(target.rules),campaignTarget:structuredClone(target),...(review.dualPairKey?{durationMs:source.durationMs,activityLimit:source.activityLimit??null}:{}),rows,
  activityBasisKey:fingerprint({reviewId:source.id,key:source.key,type,rows:source.rows,ratio:source.ratio||null}),activityBasisReviewId:source.id,
  ...(source.ratio?{kind:'sku-price-ratio',ratio:describeRatio(skus,rows,source.ratio)}:{}),...(originalUnavailable?{originalUnavailable}:{})};
}

export function blockerPriceOptions(review,context={}){
 let options=priceOptions(review);
 if(!manualPriceEditable(review))return options;
 const other=types.find(type=>type!==review.type);if(!other||!alternateSource(review,other,context))return options;
 const basis=activityPriceBasis(review,other,context);
 const alternate=priceOptions(basis).filter(option=>option.activityType===other).map(option=>({...option,
  id:'activity-'+(other==='限时抢购'?'timed':'limited')+'-'+option.id,label:other+' · '+option.label,
  campaignTarget:basis.campaignTarget||campaignChoice(other),evidenceReviewId:basis.activityBasisReviewId,
  key:fingerprint({algorithm:'activity-specific-price-v1',parentKey:review.key,basisKey:basis.activityBasisKey,option})}));
 options=options.filter(option=>option.activityType!==other);
 return [...options,...alternate];
}

export function buildActivityPriceComparison({review=null,reviews=[],tasks=[],shopId,productId,options=[],schemes={},now=Date.now()}={}){
 const failures=recordedPriceRejections({shopId,productId,reviews,tasks,now}),context=review?previousContext(review):null;
 return types.map(type=>{
  const failure=failures.find(f=>f.type===type),scheme=schemes[type],source=reviews.find(r=>r.id===failure?.reviewId);
  const outdated=!!failure&&(!context||failure.context!==context),expired=!!source&&source.expiresAt<=now;
  const candidates=options.filter(o=>o.activityType===type),available=candidates.filter(o=>o.available);
  const preferred=available.find(o=>o.id.endsWith('balanced')||o.id==='balanced')||available.find(o=>o.validationStatus!=='unverified')||available[0];
  const reference=preferred?.validationStatus==='unverified';
  const attempt=tasks.filter(t=>t.shopId===shopId&&t.plans.some(p=>p.productId===productId&&p.type===type)&&['blocked','unknown','submitting','verifying'].includes(t.phase)).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const newerAttempt=attempt&&(!failure||attempt.updatedAt>failure.at)&&!attempt.reason?.startsWith('PRICE_REVIEW_REQUIRED:');
  let rejectionState=failure?(outdated?'historical':'rejected'):scheme?.state==='verified'?'verified':'unverified';
  let reason=failure?.message||scheme?.message||'尚无本方案对应的明确平台拒绝记录';
  if(failure&&source){const details=[...new Set(source.rows.flatMap(row=>row.evidence||[]))].filter(text=>!reason.includes(text));if(details.length)reason+='；'+details.join('；');}
  if(newerAttempt){rejectionState=attempt.phase==='blocked'?'check-blocked':'pending';reason=(attempt.phase==='blocked'?'本次读取或校验受阻：':'本次提交结果尚未明确，先独立回读：')+(attempt.reason||'等待核验')+(failure?'；已记录的价格拒绝：'+failure.message:'');}
  if(failure&&outdated)reason+='（这是旧价格目标的记录，不能据此认定当前价格也失败。）';
  const data=preferred?.rows||[],ratio=preferred?.ratio;
  return {type,rejectionState,reason,rejectedAt:newerAttempt?attempt.updatedAt:failure?.at||scheme?.at||null,
   pricingState:!review?'needs-evidence':reference?'reference-only':preferred?'candidate':candidates.length?'infeasible':'needs-evidence',
   guidance:!review?'没有有效价格建议，先重新核对平台要求；过期建议不会展示。':reference?'尚未取得本类型匹配的有效价格要求，不能确定需要调到多少。下表是待核验的原折扣参考，选择后仍须确认全部价格和活动规则。':preferred?'下表按本类型已读要求推算。确认后仍须通过平台实时核验；未通过时保留原因。':candidates.length?'已读限制与 1～9.5 折档位下没有可用组合；请查看具体约束并重新核对商品规格或平台要求。':'缺少本类型有效价格依据，先重新核验；不会套用另一活动的限制。',
   unavailableReasons:[...new Set(candidates.filter(o=>!o.available).map(o=>o.reason).filter(Boolean))],
   optionId:preferred?.id||null,optionLabel:preferred?.label||null,referenceOnly:!!reference,campaignTarget:preferred?.campaignTarget||null,
   ratio:ratio?{numerator:ratio.numerator,denominator:ratio.denominator}:null,
   raised:data.filter(r=>r.saleFen>r.previousFen).length,lowered:data.filter(r=>r.saleFen<r.previousFen).length,
   rows:data.map(row=>({id:row.id,name:row.name,baseFen:row.baseFen,previousFen:row.previousFen,saleFen:row.saleFen,discount:row.discount,bounds:row.bounds||{},evidence:row.evidence||[]})),
   evidenceExpired:expired,evidenceReviewId:source?.id||null};
 });
}
