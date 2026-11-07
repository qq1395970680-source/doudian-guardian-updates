import {fingerprint,requireThat,saleFen,priceMode,priceModeFields,expectedSaleFen,validateFixedPrice,fixedActivityMaxFen} from './policy.mjs';
import {describeRatio} from './ratio-prices.mjs';

export const manualPriceEditable=r=>!['history-reconfirmation','rounding-reconfirmation','limited-rebuild'].includes(r?.kind);
export const manualFixedPriceEditable=r=>priceMode(r)==='fixed'&&manualPriceEditable(r);
// Calculate a candidate from server-owned SKU facts and bounds. Never persist,
// grant consent, alter product base prices, or invoke the platform here.
export function manualPriceOption(review,discounts,now=Date.now()){
 requireThat(review?.status==='pending'&&review.createdAt<=now&&review.expiresAt>now,'PRICE_REVIEW_EXPIRED','建议已处理或过期，请重新核对');
 requireThat(manualPriceEditable(review),'PRICE_REVIEW_CHANGED','请先核对当前历史或重建方案；新的平台价格要求核验后再自定义折扣');
 if(priceMode(review)==='fixed')return manualFixedOption(review,discounts);
 requireThat(Array.isArray(discounts)&&discounts.length===review.rows.length&&new Set(discounts.map(r=>r.id)).size===discounts.length,'PRICE_CONSENT_REQUIRED','必须提供本商品全部规格且不能重复');
 const byId=new Map(discounts.map(r=>[r.id,r.discount]));
 const rows=review.rows.map(row=>{
  const discount=byId.get(row.id),bounds=row.bounds||{};
  requireThat(Number.isInteger(discount)&&discount>=10&&discount<=95,'DISCOUNT_RANGE','折扣须为 1 至 9.5 折，每档 0.1 折');
  requireThat(row.previousFen===saleFen(row.baseFen,row.previousDiscount)&&row.saleFen===saleFen(row.baseFen,row.discount),'PRICE_REVIEW_CHANGED','原价格取整规则已变化，请重新核对');
  const price=saleFen(row.baseFen,discount);
  requireThat(discount>=(bounds.minDiscount??10)&&discount<=(bounds.maxDiscount??95)&&price>=(bounds.minFen??1)&&price<=(bounds.maxFen??Infinity),'NO_FEASIBLE_PRICE',row.name+'：自定义价格不符合已读平台价格限制');
  return {...row,discount,saleFen:price,evidence:[...(row.evidence||[]),'手动输入折扣；确认后重新核验平台当前价格要求']};
 });
 let ratio=null;if(review.ratio){
  const {numerator:n,denominator:d}=review.ratio,prices=rows.map(r=>r.saleFen);
  requireThat(Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&n>=d&&d>0,'PRICE_RULE_UNKNOWN','倍率限制无效');
  requireThat(BigInt(Math.max(...prices))*BigInt(d)<=BigInt(Math.min(...prices))*BigInt(n),'NO_FEASIBLE_PRICE','自定义价格不符合已读规格价格倍率限制');
  ratio=describeRatio(review.rows.map(r=>({...r,discount:r.previousDiscount,saleFen:r.previousFen})),rows,review.ratio);
 }
 return {id:'manual-discount',basisKey:review.activityBasisKey||null,...(review.activityBasisReviewId?{evidenceReviewId:review.activityBasisReviewId}:{}),label:'自定义折扣方案',description:'按你输入的逐规格折扣计算；确认后仍须平台实时核验。',available:true,rows,discounts:rows.map(r=>({id:r.id,discount:r.discount})),activityType:review.type,...(review.campaignTarget?{campaignTarget:review.campaignTarget}:{}),validationStatus:'candidate',...(ratio?{ratio}:{}),key:fingerprint({algorithm:'manual-discount-v1',sourceKey:review.key,activityType:review.type,basisKey:review.activityBasisKey||null,rows})};
}

function manualFixedOption(review,prices){
 requireThat(Array.isArray(prices)&&prices.length===review.rows.length&&new Set(prices.map(r=>r.id)).size===prices.length,'PRICE_CONSENT_REQUIRED','必须提供本商品全部规格的确切一口价且不能重复');
 const byId=new Map(prices.map(r=>[r.id,r]));
 const rows=review.rows.map(row=>{
  const input=byId.get(row.id),bounds=row.bounds||{};
  requireThat(input&&!Object.hasOwn(input,'discount'),'FIXED_PRICE_DISCOUNT','一口价只能输入确切金额，不接受折扣');
  expectedSaleFen(row,review);expectedSaleFen({...row,discount:row.previousDiscount,saleFen:row.previousFen},review);
  const candidate={...row,discount:null,saleFen:input.saleFen};validateFixedPrice(candidate);
  requireThat(candidate.saleFen<=fixedActivityMaxFen(candidate),'NO_FEASIBLE_PRICE',row.name+'：确切金额超出已核实官方一口价模板上限，未自动压低金额');
  requireThat(bounds.minDiscount==null&&bounds.maxDiscount==null,'PRICE_RULE_UNKNOWN','一口价不能套用折扣档位范围');
  requireThat(candidate.saleFen>=(bounds.minFen??1)&&candidate.saleFen<=(bounds.maxFen??Infinity),'NO_FEASIBLE_PRICE',row.name+'：自定义金额不符合本活动已核实的价格限制');
  return {...candidate,evidence:[...(row.evidence||[]),'手动输入确切一口价；确认后重新核验本活动当前金额要求']};
 });
 let ratio=null;if(review.ratio){
  const {numerator:n,denominator:d}=review.ratio,amounts=rows.map(r=>r.saleFen);
  requireThat(Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&n>=d&&d>0,'PRICE_RULE_UNKNOWN','倍率限制无效');
  requireThat(BigInt(Math.max(...amounts))*BigInt(d)<=BigInt(Math.min(...amounts))*BigInt(n),'NO_FEASIBLE_PRICE','自定义一口价不符合本活动已核实的规格价格倍率');
  ratio=describeRatio(review.rows.map(r=>({...r,discount:null,saleFen:r.previousFen})),rows,review.ratio);
 }
 return {...priceModeFields(review),id:'manual-fixed-price',basisKey:review.activityBasisKey||null,...(review.activityBasisReviewId?{evidenceReviewId:review.activityBasisReviewId}:{}),label:'自定义一口价方案',description:'按逐规格确切金额恢复，确认后仍须本活动实时核验。',available:true,rows,prices:rows.map(r=>({id:r.id,saleFen:r.saleFen})),activityType:review.type,...(review.campaignTarget?{campaignTarget:review.campaignTarget}:{}),validationStatus:'candidate',...(ratio?{ratio}:{}),key:fingerprint({algorithm:'manual-fixed-price-v1',sourceKey:review.key,priceMode:'fixed',activityType:review.type,basisKey:review.activityBasisKey||null,rows})};
}
