import {randomUUID} from 'node:crypto';
import {fingerprint,requireThat,normalizeName,saleFen,validateLimited} from './policy.mjs';
import {dualPriceProposalReady,dualPriceApprovalReady,dualPriceContext} from './dual-activity-recovery.mjs';

const DAY=86400000,TWO_MINUTES=120000,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const failure=(code,reason,status='needs-review')=>({ready:false,status,code,reason,authorizesSubmit:false,authorizesPriceChange:false});
const sorted=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
const rowMaterial=r=>({id:r.id,name:normalizeName(r.name),baseFen:r.baseFen,historicalDiscount:r.historicalDiscount,previousDiscount:r.previousDiscount,previousFen:r.previousFen,discount:r.discount,saleFen:r.saleFen});
function selection({review,decision,option,now,fresh=false}){
 requireThat(Number.isSafeInteger(now)&&now>0,'PRICE_INTENT_TIME','价格确认时间无效');
 requireThat(decision?.schema===1&&decision.source==='independent-dual-activity-drafts'&&dualPriceProposalReady(decision)&&!decision.resolved&&!decision.declined&&decision.plan&&hash(decision.currentContext)&&decision.currentContext===dualPriceContext(decision.plan),'PRICE_INTENT_RECHECK_REQUIRED','须有本商品当前守护目标对应的完整双方案降价事实');
 requireThat(review?.status==='pending'&&review.readOnly!==true&&review.shopId===decision.shopId&&review.productId===decision.productId&&review.historicalFingerprint===decision.historicalFingerprint&&(review.previousApprovalId||null)===(decision.previousApprovalId||null)&&review.dualPairKey===decision.pairKey&&Object.values(decision.reviewIds||{}).includes(review.id)&&hash(review.key)&&Number.isSafeInteger(review.createdAt)&&review.createdAt<=now&&Number.isSafeInteger(review.expiresAt)&&review.expiresAt>review.createdAt,'PRICE_INTENT_REVIEW_CHANGED','本次确认必须对应当前完整商品价格提案，历史记录不能批准');
 const scheme=decision.schemes.find(s=>s.type===option?.activityType),basis=scheme?.review;
 requireThat(scheme?.classification==='reduction-required'&&scheme.candidateReady!==false&&scheme.candidate?.available===true&&basis&&scheme.reviewId&&decision.reviewIds?.[scheme.type]===scheme.reviewId,'PRICE_INTENT_CANDIDATE_INCOMPLETE','所选活动尚无完整合法价格组合，不能确认仅有局部限制的方案');
 requireThat(option?.available===true&&option.validationStatus==='candidate'&&typeof option.id==='string'&&hash(option.key)&&(!option.schema||option.schema===1)&&(!option.evidenceReviewId||option.evidenceReviewId===scheme.reviewId),'PRICE_INTENT_OPTION_CHANGED','所选方案必须由服务端依据对应活动的完整提案计算');
 requireThat(basis.shopId===review.shopId&&basis.productId===review.productId&&basis.historicalFingerprint===review.historicalFingerprint&&(basis.previousApprovalId||null)===(review.previousApprovalId||null)&&basis.type===scheme.type&&Array.isArray(basis.rows)&&basis.rows.length>0&&new Set(basis.rows.map(r=>r.id)).size===basis.rows.length&&Array.isArray(option.rows)&&option.rows.length===basis.rows.length&&new Set(option.rows.map(r=>r.id)).size===option.rows.length&&review.rows.length===basis.rows.length&&!basis.skippedSkuIds?.length,'PRICE_INTENT_SKUS','必须完整确认同一商品的全部唯一规格');
 const rows=sorted(option.rows.map(r=>{
  const b=basis.rows.find(s=>s.id===r.id),shown=review.rows.find(s=>s.id===r.id),bounds=b?.bounds||{};
  requireThat(b&&shown&&/^\d{3,25}$/.test(r.id)&&normalizeName(r.name)===normalizeName(b.name)&&normalizeName(shown.name)===normalizeName(b.name)&&r.baseFen===b.baseFen&&shown.baseFen===b.baseFen&&r.historicalDiscount===b.historicalDiscount&&r.previousDiscount===b.previousDiscount&&shown.previousDiscount===b.previousDiscount&&r.previousFen===b.previousFen&&shown.previousFen===b.previousFen&&Number.isSafeInteger(r.baseFen)&&r.baseFen>0&&Number.isInteger(r.previousDiscount)&&r.previousDiscount>=1&&r.previousDiscount<=100&&Number.isInteger(r.historicalDiscount)&&r.historicalDiscount>=1&&r.historicalDiscount<=100&&Number.isSafeInteger(r.previousFen)&&r.previousFen>0&&r.previousFen===saleFen(r.baseFen,r.previousDiscount)&&Number.isInteger(r.discount)&&r.discount>=10&&r.discount<=95&&Number.isSafeInteger(r.saleFen)&&r.saleFen>0&&r.saleFen===saleFen(r.baseFen,r.discount),'PRICE_INTENT_PRICE_CHANGED','规格身份、原价、当前守护价或确切折后金额发生变化');
  requireThat(r.discount>=(bounds.minDiscount??10)&&r.discount<=(bounds.maxDiscount??95)&&r.saleFen>=(bounds.minFen??1)&&r.saleFen<=(bounds.maxFen??Infinity),'PRICE_INTENT_PRICE_BOUNDS','所选确切价格超出本活动已读的逐规格限制');return rowMaterial(r);
 }));
 requireThat(rows.some(r=>r.saleFen<r.previousFen),'PRICE_INTENT_NO_REDUCTION','本方案无需降低当前守护价，应由原价自动恢复路径处理');
 const target=basis.campaignTarget||{type:basis.type,rules:basis.rules,durationMs:basis.durationMs??48*3600000,activityLimit:basis.type==='限时抢购'?null:basis.activityLimit??null};
 const activity={type:target.type,rules:structuredClone(target.rules),durationMs:target.durationMs,activityLimit:target.activityLimit??null};
 requireThat(activity.type===scheme.type&&activity.rules&&Number.isSafeInteger(activity.durationMs)&&activity.durationMs>0&&activity.durationMs%1000===0,'PRICE_INTENT_ACTIVITY_CHANGED','活动类型、规则或时长不完整');
 // Old limited-to-timed dry plans may retain an inert top-level quota.
 // A timed no-limit target has no physical quota. Keep original evidence and
 // currentContext unchanged; canonicalize only the exact intent material.
 requireThat(fingerprint({type:basis.type,rules:basis.rules,durationMs:basis.durationMs??target.durationMs,activityLimit:basis.type==='限时抢购'?null:basis.activityLimit??null})===fingerprint(activity),'PRICE_INTENT_ACTIVITY_CHANGED','本方案规则、时长或额度与核验来源不一致');
 if(activity.type==='限量抢购')validateLimited(activity);else requireThat(activity.type==='限时抢购'&&activity.activityLimit==null&&activity.rules.noLimit===true,'PRICE_INTENT_ACTIVITY_CHANGED','限时活动不能附带新的限量额度');
 if(option.campaignTarget)requireThat(fingerprint({type:option.campaignTarget.type,rules:option.campaignTarget.rules,durationMs:option.campaignTarget.durationMs,activityLimit:option.campaignTarget.activityLimit??null})===fingerprint(activity),'PRICE_INTENT_ACTIVITY_CHANGED','选项与本活动实际核验的规则或额度不一致');
 if(basis.ratio){const{numerator:n,denominator:d}=basis.ratio,prices=rows.map(r=>r.saleFen);requireThat(Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&d>0&&n>=d&&BigInt(Math.max(...prices))*BigInt(d)<=BigInt(Math.min(...prices))*BigInt(n),'PRICE_INTENT_PRICE_BOUNDS','确切价格不符合该方案已核实的规格倍率');}
 if(fresh)requireThat(dualPriceApprovalReady(decision)&&decision.expiresAt>now&&basis.expiresAt>now&&review.expiresAt>now&&Number.isSafeInteger(scheme.evidenceAt)&&scheme.evidenceAt<=now&&now-scheme.evidenceAt<=TWO_MINUTES,'PRICE_INTENT_NOT_FRESH','两种活动及完整所选方案尚未重新取得新鲜核验依据');
 return{scheme,basis,rows,desired:{shopId:review.shopId,productId:review.productId,historicalFingerprint:review.historicalFingerprint,previousApprovalId:review.previousApprovalId||null,currentContext:decision.currentContext,...activity,rows}};
}

// Internal server adapter only: option and decision must be loaded/computed by
// the server, never copied from a client-supplied option or serialized scope.
// Saving this object changes neither a price target nor submission authority.
export function createPriceApprovalIntent({review,decision,option,args={},now=Date.now()}={}){
 const selected=selection({review,decision,option,now});
 requireThat(args.shopId===review.shopId&&(!args.productId||args.productId===review.productId)&&args.reviewId===review.id&&args.key===review.key&&args.dualPairKey===decision.pairKey&&(!args.currentContext||args.currentContext===decision.currentContext)&&args.decision==='approve'&&args.optionId===option.id&&args.optionKey===option.key,'PRICE_INTENT_CONTEXT_CHANGED','所确认店铺、商品、提案或价格选项已变化');
 requireThat(args.acceptPriceAndRisk===true&&args.acceptBlockedPriceChange===true&&Array.isArray(args.confirmedSkuIds)&&args.confirmedSkuIds.length===selected.rows.length&&new Set(args.confirmedSkuIds).size===args.confirmedSkuIds.length&&selected.rows.every(r=>args.confirmedSkuIds.includes(r.id)),'PRICE_CONSENT_REQUIRED','须明确同意本商品价格及风险，并确认每一个唯一规格');
 const expiresAt=args.intentExpiresAt??now+DAY;requireThat(Number.isSafeInteger(expiresAt)&&expiresAt>now&&expiresAt-now<=DAY,'PRICE_INTENT_TIME','本次确切价格意图最多保留一天');
 const body={schema:1,id:randomUUID(),source:'human-exact-price-awaiting-revalidation',shopId:review.shopId,productId:review.productId,historicalFingerprint:review.historicalFingerprint,previousApprovalId:review.previousApprovalId||null,currentContext:decision.currentContext,reviewId:review.id,reviewKey:review.key,pairKey:decision.pairKey,optionId:option.id,optionKey:option.key,desired:selected.desired,createdAt:now,expiresAt,
  consent:{acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:selected.rows.map(r=>r.id),exactMaterialFingerprint:fingerprint(selected.desired)},authorizesSubmit:false,authorizesPriceChange:false,requiresFreshRevalidation:true};
 return{...body,key:fingerprint(body)};
}
export function validateFreshPriceIntent(intent,{review,decision,option,now=Date.now()}={}){
 try{
  requireThat(intent?.schema===1&&intent.source==='human-exact-price-awaiting-revalidation'&&hash(intent.key)&&intent.key===fingerprint({...intent,key:undefined})&&intent.authorizesSubmit===false&&intent.authorizesPriceChange===false&&intent.requiresFreshRevalidation===true&&intent.consent?.acceptPriceAndRisk===true&&intent.consent.acceptBlockedPriceChange===true&&intent.consent.exactMaterialFingerprint===fingerprint(intent.desired),'PRICE_INTENT_INVALID','保存的确切价格意图或明确同意材料已变化');
  requireThat(Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(intent.createdAt)&&intent.createdAt>0&&intent.createdAt<=now&&Number.isSafeInteger(intent.expiresAt)&&intent.expiresAt>now&&intent.expiresAt>intent.createdAt&&intent.expiresAt-intent.createdAt<=DAY,'PRICE_INTENT_EXPIRED','本次确切价格意图已过期，需要重新确认');
  requireThat(decision?.shopId===intent.shopId&&decision.productId===intent.productId&&decision.historicalFingerprint===intent.historicalFingerprint&&(decision.previousApprovalId||null)===intent.previousApprovalId&&decision.currentContext===intent.currentContext,'PRICE_INTENT_CHANGED','本店本商品的历史或当前守护价格上下文已经变化');
  if(decision.valid===true&&decision.requiresRevalidation!==true&&decision.expiresAt>now&&decision.schemes?.some(s=>s.classification==='non-reducing'&&s.evidenceAt<=now&&now-s.evidenceAt<=TWO_MINUTES))return failure('PRICE_INTENT_NON_REDUCING_AVAILABLE','新核验已发现无需降价的方案，停止旧降价意图并交由原价自动恢复。','automatic');
  const selected=selection({review,decision,option,now,fresh:true});
  requireThat(intent.shopId===review.shopId&&intent.productId===review.productId&&intent.historicalFingerprint===review.historicalFingerprint&&intent.previousApprovalId===(review.previousApprovalId||null)&&intent.currentContext===decision.currentContext&&fingerprint(intent.desired)===fingerprint(selected.desired)&&Array.isArray(intent.consent.confirmedSkuIds)&&intent.consent.confirmedSkuIds.length===selected.rows.length&&new Set(intent.consent.confirmedSkuIds).size===selected.rows.length&&selected.rows.every(r=>intent.consent.confirmedSkuIds.includes(r.id)),'PRICE_INTENT_CHANGED','新核验的规格、价格、当前守护目标或活动规则已变化，需要重新查看并确认');
  return{ready:true,status:'ready',code:'PRICE_INTENT_REVALIDATED',reason:'新鲜核验与已明确确认的全部确切价格一致；仍须通过原批准及实际提交守门。',authorizesSubmit:false,authorizesPriceChange:false,args:{shopId:review.shopId,reviewId:review.id,key:review.key,decision:'approve',dualPairKey:decision.pairKey,optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:selected.rows.map(r=>r.id),...(option.id==='manual-discount'?{manualDiscounts:selected.rows.map(r=>({id:r.id,discount:r.discount})),manualActivityType:option.activityType}:{})}};
 }catch(error){return failure(error.code||'PRICE_INTENT_CHANGED',String(error.message||'确切价格尚未重新核实'));}
}
