import {fingerprint,normalizeName,requireThat,saleFen,validateHistorical,restorationDuration} from './policy.mjs';
import {carePriceCandidate} from './care-recovery-policy.mjs';
import {combinePriceConstraints} from './price-constraints.mjs';
import {selectRatioPrices} from './ratio-prices.mjs';
import {parseRemovalPriceRatio} from './removal-export.mjs';
import {assertCampaignPolicy} from './campaign-policy.mjs';

const failure='LEGACY_PRICE_FLOOR_INVALID';
const check=(value,message)=>requireThat(value,failure,message);
const identity=r=>({shopId:r.shopId,productId:r.productId,key:r.key,historicalFingerprint:r.historicalFingerprint,
 previousApprovalId:r.previousApprovalId||null,type:r.type,rules:r.rules,campaignTarget:r.campaignTarget||null,
 durationMs:r.durationMs??null,activityLimit:r.activityLimit??null,skippedSkuIds:r.skippedSkuIds||[]});
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const sourceMaterial=source=>Object.fromEntries(Object.entries(source).filter(([key])=>!['id','key','source','taskId','sourceProof','createdAt','expiresAt','status'].includes(key)));

// This proves only which exact amounts an old automatic approval left behind.
// It deliberately does NOT validate the ambiguous ratio as a current rule and
// cannot satisfy Journal.assertPricePlans or a financial submission boundary.
function canonicalFloor(journal,plan,{requireCurrentTarget=true,now=Date.now()}={}){
 check(plan&&typeof plan.shopId==='string'&&typeof plan.productId==='string'&&plan.priceApprovalId&&plan.priceApprovalKey,'缺少原守护目标身份');
 check(plan.fingerprint===fingerprint({...plan,fingerprint:undefined}),'旧目标执行计划材料指纹已变化');
 const review=journal.priceReview(plan.priceApprovalId),source=review?.careSource,consent=review?.automaticConsent;
 check(review?.status==='approved'&&review.approvalKind==='automatic-price-increase'&&review.kind==='sku-price-ratio'&&
  review.source==='live-platform-removal-export'&&consent?.careGrantId&&!consent.dualGrantId&&!consent.careKind&&consent.continueGuardingExactPrices===true,
 '仅能重新核实旧省心守护留下的完整倍率价格目标');
 check(Number.isFinite(review.approvedAt)&&review.approvedAt>0&&review.approvedAt<=now+5000&&review.shopId===plan.shopId&&review.productId===plan.productId&&
  review.key===plan.priceApprovalKey&&review.historicalFingerprint===plan.historicalFingerprint&&source?.id===review.id&&source.status==='pending'&&
  source.source==='live-platform-removal-export'&&source.kind==='sku-price-ratio'&&fingerprint(identity(source))===fingerprint(identity(review)),
 '旧目标的店铺、商品、历史或原批准身份不一致');
 check(consent.targetsFingerprint===fingerprint(review.rows)&&consent.sourceFingerprint===fingerprint(source)&&
  consent.evidenceFingerprint===fingerprint(review.careEvidence)&&source.key===fingerprint(sourceMaterial(source)),
 '旧目标、完整原材料或原证据指纹已变化');
 if(requireCurrentTarget){check(journal.priceTarget(plan.shopId,plan.productId)?.id===review.id,'当前守护目标已变化');assertCampaignPolicy(journal,plan.shopId,[plan]);}
 const grant=journal.settings('care-recovery-grant:'+plan.shopId+':'+consent.careGrantId);
 check(grant?.schema===1&&grant.id===consent.careGrantId&&grant.shopId===plan.shopId&&grant.source==='human-app-care-recovery-consent'&&
  grant.mode==='original-first-explicit-nondecreasing-prices'&&grant.allowMatchedRisk===true&&Number.isFinite(grant.at)&&grant.at>0&&grant.at<=review.approvedAt&&
  grant.key===fingerprint({...grant,key:undefined}),'原省心守护授权档案缺失或已变化');
 const baseline=journal.histories(plan.shopId).find(b=>b.productId===plan.productId&&fingerprint(b)===plan.historicalFingerprint);
 check(baseline,'旧目标对应的完整历史缺失');validateHistorical(baseline);
 if(!plan.campaignPolicyFingerprint&&!plan.productCampaignApprovalId)check(plan.type===baseline.type&&fingerprint(plan.rules)===fingerprint(baseline.rules)&&
  restorationDuration(plan)===restorationDuration(baseline)&&(plan.activityLimit??null)===(baseline.activityLimit??null),'原活动类型、规则、确切时长或额度已变化');
 check(baseline.shopId===plan.shopId&&Array.isArray(review.rows)&&Array.isArray(source.rows)&&Array.isArray(plan.skus)&&review.rows.length>0&&
  review.rows.length===source.rows.length&&review.rows.length===baseline.skus.length&&review.rows.length===plan.skus.length&&
  !(review.skippedSkuIds||[]).length&&!(source.skippedSkuIds||[]).length&&!(plan.skippedSkuIds||[]).length&&
  plan.type===review.type&&fingerprint(plan.rules)===fingerprint(review.rules),'必须保留同类活动和全部原规格');
 const prior=source.previousApprovalId?journal.priceReview(source.previousApprovalId):null;
 check(!source.previousApprovalId||prior?.status==='approved'&&prior.id!==review.id&&prior.shopId===plan.shopId&&prior.productId===plan.productId&&
  prior.historicalFingerprint===plan.historicalFingerprint&&prior.rows?.length===source.rows.length,'此前价格来源不完整');
 const seen=new Set(),names=new Set();
 for(const row of source.rows){
  const approved=review.rows.filter(r=>r.id===row.id),current=plan.skus.filter(r=>r.id===row.id),original=baseline.skus.filter(r=>r.id===row.id),previous=prior?.rows.filter(r=>r.id===row.id);
  const sku=current[0],old=original[0],target=approved[0],name=normalizeName(row.name);
  check(typeof row.id==='string'&&/^\d{3,25}$/.test(row.id)&&name&&row.name===name&&!seen.has(row.id)&&!names.has(name)&&approved.length===1&&current.length===1&&original.length===1&&
   (!prior||previous?.length===1)&&normalizeName(old.name)===name&&sku.name===name&&target.name===name&&
   row.baseFen===old.baseFen&&sku.baseFen===old.baseFen&&target.baseFen===old.baseFen&&row.historicalDiscount===old.discount&&target.historicalDiscount===old.discount&&
   (sku.originalDiscount??sku.discount)===old.discount&&row.previousDiscount===(previous?.[0]?.discount??old.discount)&&row.previousFen===(previous?.[0]?.saleFen??saleFen(old.baseFen,old.discount))&&
   row.previousFen===saleFen(row.baseFen,row.previousDiscount)&&target.previousDiscount===row.previousDiscount&&target.previousFen===row.previousFen&&
   Number.isInteger(target.discount)&&target.discount>=10&&target.discount<=95&&target.saleFen===saleFen(target.baseFen,target.discount)&&target.saleFen>=row.previousFen&&
   sku.discount===target.discount&&sku.saleFen===target.saleFen&&row.saleFen===saleFen(row.baseFen,row.discount),'全部规格、原价或确切守护金额已变化');
  seen.add(row.id);names.add(name);
 }
 const reason=source.sourceProof?.record?.reason;
 check(typeof reason==='string'&&source.sourceProof.activityType===source.type&&Number.isFinite(source.createdAt)&&source.createdAt>0&&source.createdAt<=review.approvedAt&&
  review.approvedAt-source.createdAt<=30000&&source.expiresAt>review.approvedAt,'原倍率来源的类型或批准时效不完整');
 // The regular validator must reach precisely its ambiguity rejection, after
 // checking the original official export identity and observation timestamps.
 let ambiguity=false;
 try{carePriceCandidate(source,review.careEvidence,review.approvedAt);}catch(error){ambiguity=error.code==='REMOVAL_RULE_AMBIGUOUS';}
 check(ambiguity,'旧自动批准不是可独立重新核实的多倍率来源');
 const ratio=source.ratio;
 check(Number.isSafeInteger(ratio?.numerator)&&ratio.numerator>0&&Number.isSafeInteger(ratio.denominator)&&ratio.denominator>0,'原保存倍率材料不完整');
 const readRatios=reason.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>parseRemovalPriceRatio(line));
 check(readRatios.some(r=>r.numerator*ratio.denominator===ratio.numerator*r.denominator),'旧数值不在原官方材料中');
 const bounds=source.rows.map(row=>{
  check(Array.isArray(row.evidence)&&row.evidence.includes(reason),'原逐规格证据不完整');
  const parsed=combinePriceConstraints(row.evidence.filter(text=>text!==reason));check(fingerprint(parsed)===fingerprint(row.bounds||{}),'原逐规格价格限制已变化');
  return{...parsed,minFen:Math.max(row.previousFen,parsed.minFen??0)};
 });
 // Replay old arithmetic ONLY to detect corrupt historical rows. The result
 // remains an inert floor, never an accepted new platform constraint.
 const selected=selectRatioPrices(source.rows.map(r=>({id:r.id,baseFen:r.baseFen,discount:r.previousDiscount,saleFen:r.previousFen})),ratio,bounds);
 const expectedRows=source.rows.map((row,index)=>({...row,discount:selected[index].discount,saleFen:selected[index].saleFen}));
 check(fingerprint(expectedRows)===fingerprint(review.rows)&&review.rows.some(r=>r.saleFen>r.previousFen),'原批准的完整确切金额无法重放');
 const material={schema:1,source:'legacy-care-ambiguous-ratio-price-floor',shopId:plan.shopId,productId:plan.productId,
  historicalFingerprint:plan.historicalFingerprint,reviewId:review.id,reviewKey:review.key,reviewFingerprint:fingerprint(review),grantFingerprint:fingerprint(grant),
  legacyReview:structuredClone(review),legacyGrant:structuredClone(grant),plan:structuredClone(plan),
  authorizesSubmit:false,requiresFreshDualProofs:true,reasonCode:'REMOVAL_RULE_AMBIGUOUS'};
 return freeze({...material,key:fingerprint(material)});
}

export function assertDualPriceBasis(journal,plan,now=Date.now()){
 try{journal.assertPricePlans(plan.shopId,[plan]);return null;}
 catch(error){if(error.code!=='PRICE_APPROVAL_CHANGED')throw error;
  try{return canonicalFloor(journal,plan,{requireCurrentTarget:true,now});}catch{throw error;}
 }
}

export function validateLegacyPriceFloor(journal,plan,proof,{requireCurrentTarget=true,now=Date.now()}={}){
 const expected=canonicalFloor(journal,plan,{requireCurrentTarget,now});
 check(proof?.key===fingerprint({...proof,key:undefined})&&fingerprint(proof)===fingerprint(expected),'重新核实的价格下限与完整旧目标原文不一致');
 return expected;
}
