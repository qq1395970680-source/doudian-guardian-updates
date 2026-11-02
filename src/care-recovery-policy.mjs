import {randomUUID} from 'node:crypto';
import {id,requireThat,fingerprint,saleFen} from './policy.mjs';
import {priceOptions} from './price-options.mjs';
import {combinePriceConstraints} from './price-constraints.mjs';
import {validateRemovalPriceEvidence} from './ratio-prices.mjs';
import {assertPriceReconfirmation} from './price-reconfirmation.mjs';

const currentKey=shop=>'care-recovery-policy:'+id(shop),grantKey=(shop,grant)=>'care-recovery-grant:'+id(shop)+':'+grant;
const source='human-app-care-recovery-consent';
const validGrant=(grant,shop,now)=>grant?.schema===1&&grant.shopId===shop&&grant.source===source&&grant.mode==='original-first-explicit-nondecreasing-prices'&&
 grant.allowMatchedRisk===true&&grant.at>0&&grant.at<=now&&typeof grant.id==='string'&&grant.key===fingerprint({...grant,key:undefined});
export function activeCareRecoveryGrant(journal,shop,now=Date.now()){
 if(!shop)return null;const current=journal.settings(currentKey(shop));if(current?.enabled!==true)return null;
 const grant=journal.settings(grantKey(shop,current.grantId));return validGrant(grant,shop,now)?grant:null;
}
export function setCareRecoveryPolicy(journal,shop,{enabled,acceptNonReducingRecovery=false}={},now=Date.now()){
 id(shop);requireThat(journal.settings('application')?.accounts?.some(a=>a.shopId===shop&&a.originalRiskAllowed===true),'CARE_CONSENT_REQUIRED','请先明确授权本店按原折扣守护');
 requireThat(typeof enabled==='boolean'&&(!enabled||acceptNonReducingRecovery===true),'CARE_CONSENT_REQUIRED','须明确同意原价优先、仅按本类型明确价格要求且全部规格不降价时自动调整；任何降价继续人工确认');
 return journal.transaction(()=>{
  let grant=activeCareRecoveryGrant(journal,shop,now);
  if(enabled&&!grant){const value={schema:1,id:randomUUID(),shopId:shop,source,mode:'original-first-explicit-nondecreasing-prices',allowMatchedRisk:true,at:now};grant={...value,key:fingerprint(value)};journal.putSettings(grantKey(shop,grant.id),grant);}
  const current={schema:1,shopId:shop,enabled,grantId:grant?.id||journal.settings(currentKey(shop))?.grantId||null,at:now};
  journal.putSettings(currentKey(shop),current);journal.event(null,enabled?'care-recovery-enabled':'care-recovery-disabled',{shopId:shop,grantId:current.grantId},now);return current;
 });
}

export function careSourceEvidence(journal,review){
 const task=review.taskId?journal.get(review.taskId):null,plan=task?.plans.find(p=>p.productId===review.productId);
 return task?{task:{id:task.id,shopId:task.shopId,phase:task.phase,submitAttempts:task.submitAttempts,riskAttempts:task.riskAttempts,
  submittedAt:task.submittedAt,riskAttemptedAt:task.riskAttemptedAt,receipt:task.receipt,plans:plan?[structuredClone(plan)]:[],
  lossEvidence:{priceRules:(task.lossEvidence?.priceRules||[]).filter(loss=>loss.removal?.productId===review.productId)}}}:{};
}
// The candidate is recalculated from this activity's independent, direct
// evidence. No activity switch, base-price edit, missing SKU or reduction is
// authorized by this shop policy.
export function carePriceCandidate(review,evidence={},now=Date.now()){
 requireThat(review?.status==='pending'&&review.createdAt>0&&review.createdAt<=now&&now-review.createdAt<=30000&&review.expiresAt>now,'PRICE_REVIEW_EXPIRED','省心调整需要本次新鲜且完整的价格依据');
 requireThat(!['history-reconfirmation','rounding-reconfirmation','limited-rebuild'].includes(review.kind)&&Array.isArray(review.rows)&&review.rows.length>0&&new Set(review.rows.map(r=>r.id)).size===review.rows.length&&!review.skippedSkuIds?.length,'CARE_REVIEW_REQUIRED','规格或活动重建来源需先独立核实');
 let ratioReason=null;
 const plan={shopId:review.shopId,productId:review.productId,type:review.type,skus:review.rows.map(row=>({id:row.id,name:row.name,baseFen:row.baseFen,discount:row.previousDiscount,saleFen:row.previousFen}))};
 if(review.source==='live-platform-draft'){
  const task=evidence.task,sourcePlan=task?.plans.find(p=>p.productId===review.productId);
  requireThat(task?.shopId===review.shopId&&task.phase==='blocked'&&task.submitAttempts===0&&(task.riskAttempts||0)===0&&!task.submittedAt&&!task.riskAttemptedAt&&!task.receipt&&sourcePlan?.type===review.type&&fingerprint(sourcePlan.rules)===fingerprint(review.rules)&&sourcePlan.historicalFingerprint===review.historicalFingerprint&&sourcePlan.skus.length===review.rows.length&&review.rows.every(row=>{
   const sku=sourcePlan.skus.find(s=>s.id===row.id);return sku&&sku.name===row.name&&sku.baseFen===row.baseFen&&sku.discount===row.previousDiscount&&sku.saleFen===row.previousFen&&(sku.originalDiscount??sku.discount)===row.historicalDiscount;
  }),'PRICE_REVIEW_CHANGED','自动调价必须来自本商品尚未提交的完整草稿，且类型、历史和全部规格均一致');
  if(review.ratio){const losses=(task.lossEvidence?.priceRules||[]).filter(loss=>loss.removal?.productId===review.productId&&loss.removalEvidence?.activityType===review.type);requireThat(losses.length===1,'PRICE_REVIEW_EVIDENCE','规格倍率必须有本类型明确依据');const ratio=validateRemovalPriceEvidence(sourcePlan,losses[0],review.createdAt);requireThat(ratio.numerator===review.ratio.numerator&&ratio.denominator===review.ratio.denominator,'PRICE_REVIEW_EVIDENCE','倍率依据已变化');ratioReason=losses[0].removal.reason;}
 }else if(review.source==='live-platform-removal-export'){
  const proof=review.sourceProof;requireThat(proof?.activityType===review.type&&review.ratio,'PRICE_REVIEW_EVIDENCE','不能借用另一活动的倍率规则');
  const ratio=validateRemovalPriceEvidence(plan,{complete:true,active:false,observedAt:proof.observedAt,lossKey:proof.lossKey,removal:proof.record,removalEvidence:proof},review.createdAt);
  requireThat(ratio.numerator===review.ratio.numerator&&ratio.denominator===review.ratio.denominator,'PRICE_REVIEW_EVIDENCE','倍率规则不能推测');ratioReason=proof.record.reason;
 }else requireThat(false,'PRICE_REVIEW_EVIDENCE','自动调整只接受本类型完整草稿或平台剔除明细');
 for(const row of review.rows){
  requireThat(row.previousFen===saleFen(row.baseFen,row.previousDiscount)&&row.saleFen===saleFen(row.baseFen,row.discount),'PRICE_REVIEW_CHANGED','价格取整或已有金额发生变化');
  const statements=(row.evidence||[]).filter(text=>text!==ratioReason),bounds=combinePriceConstraints(statements);
  requireThat(fingerprint(bounds)===fingerprint(row.bounds||{}),'PRICE_RULE_UNKNOWN','价格范围与明确平台提示不一致');
 }
 const candidate=priceOptions(review).find(option=>option.id==='balanced'&&option.available&&option.activityType===review.type);
 requireThat(candidate&&candidate.rows.length===review.rows.length&&candidate.rows.every(row=>row.saleFen>=row.previousFen)&&candidate.rows.some(row=>row.saleFen>row.previousFen),'CARE_REVIEW_REQUIRED','没有全部规格均不降价的本类型合法候选，需要人工确认降价或重新取证');
 return candidate;
}
export function validCarePriceApproval(journal,review){
 try{
  const consent=review?.automaticConsent;if(review?.status!=='approved'||review.approvalKind!=='automatic-price-increase'||!consent?.careGrantId||!review.careSource||consent.targetsFingerprint!==fingerprint(review.rows)||consent.sourceFingerprint!==fingerprint(review.careSource))return false;
  const grant=journal.settings(grantKey(review.shopId,consent.careGrantId));if(!validGrant(grant,review.shopId,review.approvedAt)||consent.continueGuardingExactPrices!==true)return false;
  const identity=r=>({shopId:r.shopId,productId:r.productId,key:r.key,historicalFingerprint:r.historicalFingerprint,previousApprovalId:r.previousApprovalId||null,type:r.type,rules:r.rules,campaignTarget:r.campaignTarget||null,durationMs:r.durationMs??null,activityLimit:r.activityLimit??null,skippedSkuIds:r.skippedSkuIds||[]});
  if(fingerprint(identity(review))!==fingerprint(identity(review.careSource)))return false;
  if(consent.careKind==='rounding-reconfirmation'){
   const previous=journal.priceReview(review.previousApprovalId);assertPriceReconfirmation(review.careSource,previous);
   return review.rows.length===previous.rows.length&&review.rows.every(row=>row.saleFen>=row.previousFen)&&fingerprint(review.rows)===fingerprint(review.careSource.rows)&&review.type===previous.type&&fingerprint(review.rules)===fingerprint(previous.rules);
  }
  return consent.evidenceFingerprint===fingerprint(review.careEvidence)&&fingerprint(carePriceCandidate(review.careSource,review.careEvidence,review.approvedAt).rows)===fingerprint(review.rows);
 }catch{return false;}
}
