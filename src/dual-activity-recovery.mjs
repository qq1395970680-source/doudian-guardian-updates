import {randomUUID} from 'node:crypto';
import {fingerprint,id,requireThat,proveDraft,saleFen,normalizeName} from './policy.mjs';
import {campaignChoice} from './campaign-choice.mjs';
import {makePriceReviews,makeNecessaryReductionEvidence} from './price-review.mjs';
import {priceOptions} from './price-options.mjs';
import {makeRemovalPriceReview} from './ratio-prices.mjs';
import {assertPriceReconfirmation} from './price-reconfirmation.mjs';
import {getSubmissionArchive} from './submission-archive.mjs';
import {assertDualPriceBasis,validateLegacyPriceFloor} from './legacy-price-floor.mjs';

const verifiedScope=Symbol('journal-verified-recovery-scope');
function readScopeRestriction(journal,scope,plan,at){
 requireThat(journal&&scope?.source==='current-unresolved-recovery-retirement'&&scope.key===fingerprint({...scope,key:undefined})&&scope.shopId===plan.shopId&&scope.historicalOutcome==='unknown'&&scope.success===false&&scope.grantsNewPriceAuthority===false&&scope.noQuotaIncrease===true,'DUAL_SCOPE_INVALID','恢复活动范围必须来自已保存且未改动的非成功归档');
 const record=typeof journal.unresolvedRecovery==='function'?journal.unresolvedRecovery(scope.taskId):getSubmissionArchive(journal,scope.taskId);
 requireThat(record?.id===scope.id&&record.shopId===plan.shopId&&record.taskId===scope.taskId&&fingerprint(record.closure)===fingerprint(scope)&&scope.originalTaskFingerprint===fingerprint(record.original)&&record.retiredAt<=at+5000&&Number.isSafeInteger(scope.consentExpiresAt)&&scope.consentExpiresAt>at,'DUAL_SCOPE_INVALID','本次活动限制与真实归档、原材料或授权期限不一致');
 const rows=scope.perProduct?.filter(r=>r.productId===plan.productId),row=rows?.[0],floor=scope.priceFloors?.find(p=>p.productId===plan.productId);
 requireThat(rows?.length===1&&row.sourceHistoricalFingerprint===plan.historicalFingerprint&&floor?.historicalFingerprint===plan.historicalFingerprint&&Array.isArray(row.allowedTypes)&&row.allowedTypes.length>0&&new Set(row.allowedTypes).size===row.allowedTypes.length&&row.allowedTypes.every(t=>dualActivityTypes.includes(t))&&fingerprint(floor.allowedTypes)===fingerprint(row.allowedTypes)&&fingerprint(scope.allowedActivityTypesByProduct)===fingerprint(scope.perProduct),'DUAL_SCOPE_INVALID','本次商品、历史或允许活动范围不完整');
 const quantityExclusion=row.forbidNewLimitedQuota===true&&fingerprint(row.allowedTypes)===fingerprint(['限时抢购'])&&scope.sourceReferences?.some(s=>s.productId===plan.productId&&s.kind==='price-template'&&s.type==='限时抢购')&&scope.sourceReferences.filter(s=>s.productId===plan.productId).every(s=>s.type==='限时抢购');
 const bounds=scope.quantityBounds?.filter(b=>b.productId===plan.productId)||[],bound=bounds[0];
 const preserveLimitedQuota=row.preserveLimitedQuota===true&&row.forbidNewLimitedQuota===false&&fingerprint(row.allowedTypes)===fingerprint(['限量抢购'])&&bounds.length===1&&bound.soldOut===false&&
  Number.isSafeInteger(bound.maxActivityLimit)&&bound.maxActivityLimit>=1&&Number.isSafeInteger(bound.sourceActivityLimit)&&bound.maxActivityLimit<=bound.sourceActivityLimit&&bound.sourceActivityLimit<=1000&&
  typeof bound.evidenceFingerprint==='string'&&/^[a-f0-9]{64}$/i.test(bound.evidenceFingerprint)&&row.sourceCampaignId===bound.sourceCampaignId&&
  scope.sourceReferences?.some(s=>s.productId===plan.productId&&s.historicalFingerprint===plan.historicalFingerprint&&['recorded-loss','price-template'].includes(s.kind)&&s.type==='限量抢购'&&s.campaignId===bound.sourceCampaignId);
 requireThat(row.preserveLimitedQuota!==true||preserveLimitedQuota,'DUAL_SCOPE_INVALID','保留限量额度须绑定原限量来源、未售罄和完整有效的额度上限');
 const excluded=dualActivityTypes.filter(t=>!row.allowedTypes.includes(t));
 return{row,allowedTypes:row.allowedTypes,excluded,quantityExclusion,preserveLimitedQuota,bound:preserveLimitedQuota?bound:null,scopeKind:quantityExclusion?'new-limited-quota-forbidden':preserveLimitedQuota?'preserve-limited-quota':null,closureKey:scope.key,record,floor};
}
const brandScope=(value,scope)=>{if(scope)Object.defineProperty(value,verifiedScope,{value:{pairKey:value.pairKey,closureKey:scope.closureKey,scopeKind:scope.scopeKind}});return value;};
const scopeExclusionMatches=(scheme,scopeKind)=>scheme.classification==='unavailable'&&scheme.scopeExcluded===true&&scheme.scopeExclusion===scopeKind&&
 (scopeKind==='new-limited-quota-forbidden'&&scheme.type==='限量抢购'||scopeKind==='preserve-limited-quota'&&scheme.type==='限时抢购');
const completeCandidate=s=>s?.candidateReady!==false&&!!s?.review&&!!s?.candidate&&s.candidate.available===true;
export function dualPriceProposalReady(decision){
 if(decision?.valid!==true||!(decision.approvalAllowed===true||decision.confirmationRequired===true)||!Array.isArray(decision.schemes)||decision.schemes.length!==2||!dualActivityTypes.every(t=>decision.schemes.filter(s=>s.type===t).length===1)||!decision.schemes.some(s=>s.classification==='reduction-required'&&completeCandidate(s)))return false;
 const proof=decision[verifiedScope];if(decision.scopeRestriction&&(!proof||proof.pairKey!==decision.pairKey||proof.closureKey!==decision.scopeRestriction.key))return false;
 if(decision.schemes.every(s=>s.classification==='reduction-required'))return true;
 if(!proof||proof.pairKey!==decision.pairKey||proof.closureKey!==decision.scopeRestriction?.key)return false;
 return decision.schemes.some(s=>s.classification==='reduction-required')&&decision.schemes.every(s=>s.classification==='reduction-required'||scopeExclusionMatches(s,proof.scopeKind));
}
export function dualPriceApprovalReady(decision){return decision?.approvalAllowed===true&&decision.approvalReady!==false&&decision.requiresRevalidation!==true&&dualPriceProposalReady(decision);}
export function displayProposalPricingContext(decision,review,now=Date.now()){
 requireThat(dualPriceProposalReady(decision)&&Number.isFinite(now)&&decision.createdAt>0&&decision.createdAt<=now+5000,'DUAL_PROPOSAL_UNAVAILABLE','本次价格提案已变化，先重新核验');
 const scheme=decision.schemes.find(s=>s.type===review?.type);
 requireThat(completeCandidate(scheme)&&scheme.classification==='reduction-required'&&review?.status==='pending'&&review.id===decision.reviewIds?.[review.type]&&
  review.shopId===decision.shopId&&review.productId===decision.productId&&review.historicalFingerprint===decision.historicalFingerprint&&review.dualPairKey===decision.pairKey&&
  review.key===scheme.review.key&&fingerprint(review.rows)===fingerprint(scheme.review.rows)&&review.createdAt<=decision.createdAt&&review.expiresAt>decision.createdAt,
  'DUAL_PROPOSAL_UNAVAILABLE','本活动缺少与该提案完整绑定的可确认价格，不能预览或选择');
 return{source:'dual-price-proposal-display-context',displayOnly:true,authorizesSubmit:false,authorizesPriceApproval:false,requiresRevalidation:true,
  now:decision.createdAt,pricingAsOf:decision.createdAt,displayedAt:now,evidenceExpiresAt:decision.expiresAt,dualDecision:decision,
  allowedTypes:decision.schemes.filter(s=>s.classification==='reduction-required'&&completeCandidate(s)).map(s=>s.type)};
}

export const dualActivityTypes=['限时抢购','限量抢购'];
const policyKey=shop=>'dual-activity-care-policy:'+id(shop),grantKey=(shop,grant)=>'dual-activity-care-grant:'+id(shop)+':'+grant;
export const dualDecisionKey=(shop,product)=>'dual-activity-decision:'+id(shop)+':'+id(product);
export const dualDeclineKey=(shop,product)=>'dual-activity-decline:'+id(shop)+':'+id(product);
const validGrant=(g,shop,now)=>g?.schema===1&&g.shopId===shop&&g.source==='human-app-dual-activity-consent'&&g.mode==='both-types-original-first-no-reductions'&&
 g.at>0&&g.at<=now&&g.allowMatchedRisk===true&&g.allowBothActivityTypes===true&&g.id&&Array.isArray(g.choices)&&g.choices.length===2&&dualActivityTypes.every(type=>g.choices.filter(c=>c.type===type).length===1)&&g.key===fingerprint({...g,key:undefined});
export function activeDualActivityCareGrant(journal,shop,now=Date.now()){
 if(!shop)return null;const p=journal.settings(policyKey(shop));if(p?.enabled!==true)return null;
 const grant=journal.settings(grantKey(shop,p.grantId));return validGrant(grant,shop,now)&&fingerprint(grant.choices)===fingerprint(dualActivityTypes.map(campaignChoice))?grant:null;
}
export function setDualActivityCarePolicy(journal,shop,{enabled,acceptBothActivityTypes=false,acceptNonReducingRecovery=false}={},now=Date.now()){
 id(shop);requireThat(journal.settings('application')?.accounts?.some(a=>a.shopId===shop&&a.originalRiskAllowed===true),'CARE_CONSENT_REQUIRED','请先明确授权本店原折扣守护');
 requireThat(typeof enabled==='boolean'&&(!enabled||acceptBothActivityTypes===true&&acceptNonReducingRecovery===true),'DUAL_ACTIVITY_CONSENT_REQUIRED','须明确同意分别核验两种活动、允许切换活动且仅自动采用全部规格不降价的确切价格');
 return journal.transaction(()=>{
  let grant=activeDualActivityCareGrant(journal,shop,now);
  if(enabled&&!grant){const value={schema:1,id:randomUUID(),shopId:shop,source:'human-app-dual-activity-consent',mode:'both-types-original-first-no-reductions',allowMatchedRisk:true,allowBothActivityTypes:true,choices:dualActivityTypes.map(campaignChoice),at:now};grant={...value,key:fingerprint(value)};journal.putSettings(grantKey(shop,grant.id),grant);}
  const current={schema:1,shopId:shop,enabled,grantId:grant?.id||journal.settings(policyKey(shop))?.grantId||null,at:now};journal.putSettings(policyKey(shop),current);
  journal.event(null,enabled?'dual-activity-care-enabled':'dual-activity-care-disabled',{shopId:shop,grantId:current.grantId},now);return current;
 });
}
export const dualPriceContext=plan=>fingerprint({shopId:plan.shopId,productId:plan.productId,historicalFingerprint:plan.historicalFingerprint,
 previousApprovalId:plan.priceApprovalId||null,type:plan.type,rules:plan.rules,durationMs:plan.durationMs??null,activityLimit:plan.activityLimit??null,
 skus:plan.skus.map(s=>({id:s.id,name:s.name,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen,originalDiscount:s.originalDiscount??s.discount})).sort((a,b)=>a.id.localeCompare(b.id))});
export function dualProbePlan(plan,type,choices=dualActivityTypes.map(campaignChoice)){
 requireThat(dualActivityTypes.includes(type)&&dualActivityTypes.includes(plan.type),'CAMPAIGN_CHOICE_INVALID','双方案仅支持限时抢购与限量抢购');
 if(type===plan.type)return structuredClone(plan);
 const {fingerprint:old,...body}=plan;
 // The target-type page receives the CURRENT guarded prices, never the
 // historical discounts. Current-type duration/rules remain exact.
 const target=choices.find(choice=>choice.type===type);requireThat(target,'DUAL_ACTIVITY_CONSENT_REQUIRED','本店未明确授权目标活动的确切规则');
 const result={...body,...target,campaignTarget:structuredClone(target)};delete result.campaignPolicyFingerprint;delete result.productCampaignApprovalId;
 return {...result,fingerprint:fingerprint(result)};
}
const rowsFor=plan=>plan.skus.map(s=>({id:s.id,name:normalizeName(s.name),baseFen:s.baseFen,historicalDiscount:s.originalDiscount??s.discount,previousDiscount:s.discount,previousFen:s.saleFen,discount:s.discount,saleFen:s.saleFen,bounds:{},evidence:[]}));
const pending=(type,reason,extra={})=>({type,classification:'pending',reason,evidenceAt:null,review:null,...extra});
function assertGuardedPlan(journal,plan,now=Date.now()){
 const baseline=journal.histories(plan.shopId).find(b=>b.productId===plan.productId&&fingerprint(b)===plan.historicalFingerprint),target=journal.priceTarget(plan.shopId,plan.productId);
 requireThat(baseline&&baseline.skus.length===plan.skus.length&&!plan.skippedSkuIds?.length,'DUAL_SKUS_INCOMPLETE','双方案必须匹配全部完整历史规格');
 requireThat((plan.priceApprovalId||null)===(target?.historicalFingerprint===plan.historicalFingerprint?target.id:null),'PRICE_REVIEW_CHANGED','此前守护目标已变化');
 const seen=new Set();for(const sku of plan.skus){const old=baseline.skus.find(s=>s.id===sku.id),approved=target&&target.id===plan.priceApprovalId?target.rows.find(s=>s.id===sku.id):null;
  requireThat(!seen.has(sku.id)&&old&&normalizeName(old.name)===sku.name&&old.baseFen===sku.baseFen&&(sku.originalDiscount??sku.discount)===old.discount&&sku.discount===(approved?.discount??old.discount)&&sku.saleFen===(approved?.saleFen??saleFen(old.baseFen,old.discount)),'PRICE_REVIEW_CHANGED','本次全部规格必须与当前已批准的确切守护价一致');seen.add(sku.id);
 }return assertDualPriceBasis(journal,plan,now);
}
function assertOriginalPriceAttempt(journal,scope,plan,guardedPlan,now){
 const closure=scope?.record?.closure,successor=scope?.record?.successor;
 requireThat(closure?.requiresFreshLossAndPriceProofs===true&&closure.noAutomaticReductions===true&&closure.maxSubmittedSuccessors===1&&scope.allowedTypes.includes(plan.type),'UNRESOLVED_ORIGINAL_PRICE_SCOPE','原价试恢复须绑定本次有效且仅一次的新恢复意图');
 // Historical approved evidence must remain replayable after its one submit.
 // A current new decision at/after consumption is still blocked by the live
 // pending-task guard and the Journal's atomic successor-consumption gate.
 const baseline=journal.histories(plan.shopId).find(b=>b.productId===plan.productId&&fingerprint(b)===plan.historicalFingerprint),target=journal.priceTarget(plan.shopId,plan.productId),prior=plan.priceApprovalId?journal.priceReview(plan.priceApprovalId):null;
 const ownApprovedReplay=target?.dualSource?.createdAt===now&&fingerprint(target.dualSource.plan)===fingerprint(guardedPlan);
 const historicalSubmitReplay=ownApprovedReplay&&Number.isSafeInteger(successor?.submittedAt)&&successor.submittedAt>=now&&target.approvedAt<=successor.submittedAt&&successor.task?.submitAttempts===1&&successor.task.submittedAt===successor.submittedAt;
 requireThat(!successor||successor.submittedAt==null&&successor.task?.submitAttempts===0&&successor.task?.riskAttempts===0||historicalSubmitReplay,'UNRESOLVED_SUCCESSOR_SUBMITTED','本次原价新恢复已使用提交资格，只能继续回读');
 requireThat((plan.priceApprovalId?prior?.status==='approved'&&prior.historicalFingerprint===plan.historicalFingerprint&&prior.rows?.length===plan.skus.length:!prior)&&((target?.id||null)===(plan.priceApprovalId||null)||ownApprovedReplay)&&baseline&&scope.floor.skus.length===plan.skus.length&&baseline.skus.length===plan.skus.length&&!plan.skippedSkuIds?.length,'UNRESOLVED_ORIGINAL_PRICE_CHANGED','本次完整当前批准价格或原守护规格发生变化');
 const seen=new Set();for(const sku of plan.skus){const old=scope.floor.skus.find(s=>s.id===sku.id),base=baseline.skus.find(s=>s.id===sku.id),expected=prior?.rows.find(s=>s.id===sku.id);
  requireThat(!seen.has(sku.id)&&old&&base&&(!prior||expected)&&base.baseFen===sku.baseFen&&old.baseFen===sku.baseFen&&normalizeName(base.name)===normalizeName(sku.name)&&sku.saleFen>=old.saleFen&&sku.discount===(expected?.discount??base.discount)&&sku.saleFen===(expected?.saleFen??saleFen(base.baseFen,base.discount))&&sku.saleFen===saleFen(sku.baseFen,sku.discount),'UNRESOLVED_ORIGINAL_PRICE_CHANGED','原价试恢复必须保留全部规格的当前批准金额，且不能低于原守护价');seen.add(sku.id);
 }
 if(scope.row.forbidNewLimitedQuota)requireThat(plan.type==='限时抢购','UNRESOLVED_QUANTITY','本次没有新限量额度授权');
 if(plan.type==='限量抢购'){const bound=closure.quantityBounds?.find(b=>b.productId===plan.productId);requireThat(bound?.soldOut===false&&Number.isSafeInteger(plan.activityLimit)&&plan.activityLimit>0&&plan.activityLimit<=bound.maxActivityLimit,'UNRESOLVED_QUANTITY','原价试恢复不能新增或突破已确认的限量额度');}
}
function classifyProbe(plan,entry,now,{scope=null,journal=null}={}){
 const type=entry.type;
 if(entry.error)return pending(type,'本方案核验尚未完成：'+String(entry.error.message||entry.error.code||'读取失败').slice(0,800),{code:entry.error.code||'READ_FAILED'});
 try{
  const task=entry.task,expected=dualProbePlan(plan,type,task?.dualProbe?.choices),probe=entry.observation;
  if(scope?.preserveLimitedQuota&&type==='限量抢购')requireThat(Number.isSafeInteger(expected.activityLimit)&&expected.activityLimit>=1&&expected.activityLimit<=scope.bound.maxActivityLimit,'UNRESOLVED_QUANTITY','本次限量方案必须保留原未售罄额度，不能新增或突破已确认上限');
  requireThat(task?.phase==='queued'&&task.submitAttempts===0&&(task.riskAttempts||0)===0&&!task.submittedAt&&!task.riskAttemptedAt&&!task.receipt&&!task.draftProof&&!task.riskProof,'DUAL_PROBE_CHANGED','双方案证据只能来自尚未提交或确认风险的独立草稿');
  requireThat(task?.shopId===plan.shopId&&task.plans?.length===1&&fingerprint(task.plans[0])===fingerprint(expected),'DUAL_PROBE_CHANGED','独立草稿与本次同商品确切价格和活动方案不一致');
  requireThat(probe?.source==='live-platform-draft'&&Number.isFinite(probe.observedAt)&&probe.observedAt>0&&probe.observedAt<=now&&now-probe.observedAt<=120000,'DUAL_PROBE_EXPIRED','本方案独立读取已过期，等待重新核验');
  proveDraft(task,{...probe,warnings:[]},probe.observedAt);
  const errors=new Set(probe.rows.flatMap(row=>row.errors||[]));
  requireThat((probe.warnings||[]).every(w=>errors.has(w)),'PRICE_RULE_UNKNOWN','本方案存在无法对应具体规格的提示');
  let review,originalPriceAttemptOnly=false,ambiguousRemovalEvidence=null;
  if(errors.size)try{review=makePriceReviews(task,probe,probe.observedAt)[0];}
  catch(error){
   if(error.code==='REMOVAL_RULE_AMBIGUOUS'){
    const necessaryReductionEvidence=makeNecessaryReductionEvidence(task,probe,probe.observedAt);
    if(necessaryReductionEvidence){const ambiguousRemovalEvidence=(task.lossEvidence?.priceRules||[]).find(l=>l.removal?.productId===plan.productId&&l.removalEvidence?.activityType===type);
     return{type,classification:'reduction-required',candidateReady:false,reason:'本方案完整草稿已明确至少一个规格必须降价；另有未明确分组的倍率要求，尚不提供本方案的可确认价格。',
      code:'REMOVAL_RULE_AMBIGUOUS',evidenceAt:probe.observedAt,review:null,candidate:null,necessaryReductionEvidence,ambiguousRemovalEvidence:structuredClone(ambiguousRemovalEvidence)};
    }
   }throw error;
  }
  else{
   const losses=(task.lossEvidence?.priceRules||[]).filter(l=>l.removal?.productId===plan.productId&&l.removalEvidence?.activityType===type);
   requireThat(losses.length<=1,'PRICE_REVIEW_EVIDENCE','本类型的剔除价格依据重复');
   if(losses.length)try{review=makeRemovalPriceReview(expected,losses[0],probe.observedAt);}catch(error){if(error.code==='REMOVAL_RULE_AMBIGUOUS'&&scope){assertOriginalPriceAttempt(journal,scope,expected,plan,now);requireThat(Array.isArray(probe.warnings)&&probe.warnings.length===0&&probe.dialogs?.length===0&&probe.rows.every(row=>Array.isArray(row.errors)&&row.errors.length===0),'PRICE_RULE_UNKNOWN','原价试恢复须完整读取且没有任何规格错误、警告或待处理提示');originalPriceAttemptOnly=true;ambiguousRemovalEvidence=structuredClone(losses[0]);}else if(error.code!=='PRICE_REVIEW_UNNEEDED')throw error;}
   review||={shopId:plan.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,previousApprovalId:plan.priceApprovalId||null,type,rules:structuredClone(expected.rules),...(expected.campaignTarget?{campaignTarget:structuredClone(expected.campaignTarget)}:{}),skippedSkuIds:[],rows:rowsFor(plan),source:'live-platform-draft',createdAt:probe.observedAt,expiresAt:probe.observedAt+120000,status:'pending'};
  }
  if(originalPriceAttemptOnly){review.originalPriceAttemptOnly=true;review.originalPriceAttemptReason='原价草稿通过，允许本次一次提交验证，尚未恢复成功；多倍率剔除原因未被合并或用于调价。';review.ambiguousRemovalEvidence=ambiguousRemovalEvidence;}
  requireThat(review&&review.rows.length===plan.skus.length&&!plan.skippedSkuIds?.length,'DUAL_SKUS_INCOMPLETE','双方案必须核对全部历史规格');
  review.expiresAt=probe.observedAt+120000;if(expected.campaignTarget)review.campaignTarget=structuredClone(expected.campaignTarget);else delete review.campaignTarget;
  if(expected.durationMs!=null)review.durationMs=expected.durationMs;if(expected.activityLimit!=null)review.activityLimit=expected.activityLimit;
  review.key=fingerprint({...review,key:undefined,taskId:undefined,createdAt:undefined,expiresAt:undefined,status:undefined});
  const options=priceOptions(review).filter(o=>o.activityType===type),balanced=options.find(o=>o.id==='balanced'&&o.available),original=options.find(o=>o.id==='original'&&o.available);
  if(originalPriceAttemptOnly)requireThat(balanced&&balanced.rows.every(row=>row.saleFen===row.previousFen&&row.discount===row.previousDiscount),'UNRESOLVED_ORIGINAL_PRICE_CHANGED','本次试恢复不得产生任何价格调整');
  if(balanced&&balanced.rows.every(row=>row.saleFen>=row.previousFen))return{type,classification:'non-reducing',reason:originalPriceAttemptOnly?review.originalPriceAttemptReason:balanced.rows.every(row=>row.saleFen===row.previousFen)?'本方案独立草稿已接受当前守护价，无须降价。':'本方案有全部规格不降价且符合本类型明确限制的候选。',evidenceAt:probe.observedAt,review,candidate:balanced,unchanged:balanced.rows.every(row=>row.saleFen===row.previousFen),...(originalPriceAttemptOnly?{originalPriceAttemptOnly:true,ambiguousRemovalEvidence}:{} )};
  if(original?.rows.some(row=>row.saleFen<row.previousFen))return{type,classification:'reduction-required',reason:'本方案已读明确价格限制；合法折扣档位内不存在全部规格不降价的组合，至少一个规格必须低于当前守护价。',evidenceAt:probe.observedAt,review,candidate:original};
  return{type,classification:'unavailable',reason:'本方案在已读限制和合法折扣档位内没有可用价格组合，不能认定为必须降价。',evidenceAt:probe.observedAt,review:null};
 }catch(error){return error.code==='NO_FEASIBLE_PRICE'?{type,classification:'unavailable',reason:'本方案没有满足已读限制的合法价格组合：'+error.message,evidenceAt:entry.observation?.observedAt||null,review:null}:pending(type,'本方案证据尚不完整：'+error.message,{code:error.code||'DUAL_PROBE_INVALID'});}
}
export function makeDualActivityDecision({plan,probes=[],now=Date.now(),scopeRestriction=null,journal=null,legacyPriceFloor=null,priceFloorReplay=false}={}){
 requireThat(plan?.skus?.length&&dualActivityTypes.includes(plan.type),'DUAL_PLAN_INVALID','缺少本次完整恢复计划');
 if(legacyPriceFloor){
  requireThat(journal,'LEGACY_PRICE_FLOOR_INVALID','旧确切价格重新核验须有原始完整记录');
  validateLegacyPriceFloor(journal,plan,legacyPriceFloor,{requireCurrentTarget:!priceFloorReplay,now});
  requireThat(probes.every(p=>!p.task||fingerprint(p.task.dualProbe?.legacyPriceFloor||null)===fingerprint(legacyPriceFloor)),'LEGACY_PRICE_FLOOR_INVALID','各独立草稿须绑定同一完整旧价格下限证明');
 }
 const scope=scopeRestriction?readScopeRestriction(journal,scopeRestriction,plan,now):null;
 const schemes=dualActivityTypes.map(type=>{if(scope&&!scope.allowedTypes.includes(type))return{type,classification:'unavailable',reason:scope.quantityExclusion?'本次未确认新限量额度，禁止新建限量活动；仅可采用合法限时方案，需降价仍由本人确认。':scope.preserveLimitedQuota?'本次须保留原限量活动的未售罄额度，仅可在已核实上限内恢复限量活动，不能改走限时绕过额度。':'本次明确恢复意图未授权该活动类型。',evidenceAt:null,review:null,scopeExcluded:true,scopeExclusion:scope.scopeKind||'activity-not-authorized',scopeClosureKey:scope.closureKey};const entries=probes.filter(p=>p.type===type);return entries.length===1?classifyProbe(plan,entries[0],now,{scope,journal}):pending(type,'本方案尚未完成独立核验');});
 const candidates=schemes.filter(s=>s.classification==='non-reducing').sort((a,b)=>Number(!a.unchanged)-Number(!b.unchanged)||Number(a.type!==plan.type)-Number(b.type!==plan.type));
 const allowed=schemes.filter(s=>!s.scopeExcluded),approvalAllowed=allowed.length>0&&allowed.every(s=>s.classification==='reduction-required')&&allowed.some(completeCandidate)&&schemes.filter(s=>s.scopeExcluded).every(s=>scope&&scopeExclusionMatches(s,scope.scopeKind));
 const body={schema:1,source:'independent-dual-activity-drafts',shopId:plan.shopId,productId:plan.productId,historicalFingerprint:plan.historicalFingerprint,previousApprovalId:plan.priceApprovalId||null,currentContext:dualPriceContext(plan),plan:structuredClone(plan),probes:structuredClone(probes),schemes,createdAt:now,
  expiresAt:Math.min(...schemes.map(s=>s.evidenceAt?s.evidenceAt+120000:now+120000)),approvalAllowed,selectedType:candidates[0]?.type||null,...(scopeRestriction?{scopeRestriction:structuredClone(scopeRestriction)}:{}),...(legacyPriceFloor?{legacyPriceFloor:structuredClone(legacyPriceFloor)}:{}),...(schemes.some(s=>s.originalPriceAttemptOnly)?{originalPriceAttemptOnly:true}: {})};
 return {...body,pairKey:fingerprint(body)};
}
export const dualDecisionIntentKey=decision=>fingerprint({currentContext:decision.currentContext,schemes:decision.schemes.map(s=>({type:s.type,classification:s.classification,
 rows:s.candidate?.rows.map(r=>({id:r.id,name:r.name,baseFen:r.baseFen,previousFen:r.previousFen,discount:r.discount,saleFen:r.saleFen}))||[]})),...(decision.scopeRestriction?{scopeClosureKey:decision.scopeRestriction.key}:{})});
export function getDualActivityDecision(journal,shop,product,now=Date.now()){
 const record=journal.settings(dualDecisionKey(shop,product));
 if(!record||record.shopId!==shop||record.productId!==product)return null;
 const invalid=reason=>({...record,approvalAllowed:false,selectedType:null,valid:false,blockedReason:reason,schemes:dualActivityTypes.map(type=>pending(type,reason))});
 if(record.recheckRequestedAt)return invalid('已请求重新核验两种活动，旧建议不能继续批准');
 if(record.pairKey!==fingerprint({...record,pairKey:undefined,reviewIds:undefined,declineSuppression:undefined,resolution:undefined}))return invalid('双方案记录校验变化，等待重新核验');
 let scope=null;try{if(record.scopeRestriction)scope=readScopeRestriction(journal,record.scopeRestriction,record.plan,now);}catch{return invalid('本次恢复范围、原意图归档或授权期限已变化，不能扩大活动类型');}
 const target=journal.priceTarget(shop,product),expected=record.previousApprovalId||null;
 if(expected!==(target?.historicalFingerprint===record.historicalFingerprint?target.id:null))return invalid('当前守护目标已变化，必须按新目标重新核验两种活动');
 const baseline=journal.histories(shop).find(b=>b.productId===product&&fingerprint(b)===record.historicalFingerprint);
 if(!baseline)return invalid('本次完整历史来源已变化');
 try{const floor=assertGuardedPlan(journal,record.plan,now);requireThat(fingerprint(floor||null)===fingerprint(record.legacyPriceFloor||null),'LEGACY_PRICE_FLOOR_INVALID','本次旧价格下限证明缺失或变化');if(record.legacyPriceFloor)validateLegacyPriceFloor(journal,record.plan,record.legacyPriceFloor,{requireCurrentTarget:true,now});}catch{return invalid('全部规格或当前已批准的确切守护价已变化');}
 if(journal.list(shop).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===product)))return invalid('已有执行中或结果未知的提交，只独立回读，不重复提交');
 const latestCheck=(journal.productChecks?.(shop)||[]).find(c=>c.productId===product),checkAt=latestCheck?.at;
 if(Number.isFinite(checkAt)&&checkAt>=record.createdAt&&(!latestCheck.contextKey||latestCheck.contextKey===record.historicalFingerprint)&&!['DUAL_REDUCTION_REQUIRED','DUAL_CHECK_PENDING'].includes(latestCheck.code)&&(!record.resolution||checkAt>=record.resolution.at))return invalid('本次独立核验受阻：'+String(latestCheck.message||latestCheck.code||'当前读取未完成').slice(0,1000));
 const resolution=record.resolution;
 if(resolution?.source==='live-platform-current-membership'&&resolution.shopId===shop&&resolution.productId===product&&resolution.observedAt>0&&resolution.observedAt<=now&&resolution.at>=record.createdAt&&typeof resolution.campaignId==='string'&&resolution.campaignId.length)return {...record,valid:true,resolved:true,approvalAllowed:false,selectedType:null,selectedReviewId:null,blockedReason:'已通过独立当前活动回读收尾，无须再次确认或创建。',schemes:record.schemes.map(s=>({...s,reviewId:record.reviewIds?.[s.type]||null}))};
 const reviews=record.schemes.filter(s=>s.review).map(s=>journal.priceReview(record.reviewIds?.[s.type]));
 if(reviews.some(r=>!r||r.shopId!==shop||r.productId!==product||r.dualPairKey!==record.pairKey))return invalid('本次双方案记录已变化，等待重新核验');
 if(reviews.length&&reviews.every(r=>r.status==='superseded'&&/有效活动/.test(r.supersededReason||'')))return {...record,valid:true,resolved:true,approvalAllowed:false,selectedType:null,selectedReviewId:null,blockedReason:'已通过独立当前活动回读收尾，无须再次确认或创建。',schemes:record.schemes.map(s=>({...s,reviewId:record.reviewIds?.[s.type]||null}))};
 if(reviews.some(r=>!['pending','declined'].includes(r.status)))return invalid('部分价格记录已处理，等待按当前状态重新核验');
 const replay=makeDualActivityDecision({plan:record.plan,probes:record.probes,now:record.createdAt,journal,...(record.scopeRestriction?{scopeRestriction:record.scopeRestriction}:{}),...(record.legacyPriceFloor?{legacyPriceFloor:record.legacyPriceFloor}:{})});
 if(replay.pairKey!==record.pairKey)return invalid('双方案完整规格或价格依据无法重放核验');
 const declined=record.approvalAllowed&&journal.settings(dualDeclineKey(shop,product))?.intentKey===dualDecisionIntentKey(record);
 if(!declined&&reviews.some(r=>r.status==='declined'))return invalid('已有暂不调整的决策，先重新核验完整双方案');
 const expired=record.expiresAt<=now;
 return brandScope({...record,valid:true,evidenceFresh:!expired,requiresRevalidation:expired,approvalReady:!expired&&!declined&&record.approvalAllowed===true,confirmationRequired:!declined&&record.approvalAllowed===true,
  ...(expired?{approvalAllowed:false,selectedType:null,blockedReason:'保留上次核验的确切价格；确认前须重新读取两种活动和当前规格，旧证据不会直接用于提交。'}:{}),
  ...(declined?{declined:true,approvalAllowed:false,blockedReason:'已选择暂不调整；相同守护目标和确切价格不会重复催办，仍会继续寻找不降价方案。'}:{}),schemes:record.schemes.map(s=>({...s,reviewId:record.reviewIds?.[s.type]||null})),selectedReviewId:expired?null:record.reviewIds?.[record.selectedType]||null},scope);
}
export function assertDualProbeAllowed(journal,task,now=Date.now()){
 const grant=activeDualActivityCareGrant(journal,task?.shopId,now),original=task?.dualProbe?.plan;
 requireThat(grant&&task.dualProbe.grantId===grant.id&&original?.shopId===task.shopId&&task.plans?.length===1,'DUAL_ACTIVITY_CONSENT_REQUIRED','双方案独立核验需要本店本次明确授权');
 requireThat(fingerprint(task.dualProbe.choices)===fingerprint(grant.choices)&&fingerprint(task.plans[0])===fingerprint(dualProbePlan(original,task.plans[0].type,grant.choices)),'DUAL_PROBE_CHANGED','核验草稿超出当前守护价或已授权的方案范围');
 requireThat(!journal.list(task.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===original.productId)),'PENDING','已有未完成或未知提交，禁止重新创建草稿');
 const floor=assertGuardedPlan(journal,original,now);requireThat(fingerprint(floor||null)===fingerprint(task.dualProbe.legacyPriceFloor||null),'LEGACY_PRICE_FLOOR_INVALID','核验草稿与当前完整旧价格下限证明不一致');
 requireThat(original.observedAt>0&&original.observedAt<=now&&now-original.observedAt<=120000,'STALE_OR_INCOMPLETE','双方案当前完整规格读取已过期');
}
export function validDualActivityApproval(journal,review){
 try{
  const c=review?.automaticConsent;if(review.status!=='approved'||review.approvalKind!=='automatic-price-increase'||!c?.dualGrantId||c.continueGuardingExactPrices!==true||c.targetsFingerprint!==fingerprint(review.rows))return false;
  const grant=journal.settings(grantKey(review.shopId,c.dualGrantId));if(!validGrant(grant,review.shopId,review.approvedAt))return false;
  if(c.dualKind==='rounding-reconfirmation'){
   const source=review.dualRoundingSource,previous=journal.priceReview(review.previousApprovalId);if(!source||c.sourceFingerprint!==fingerprint(source)||previous?.id===review.id)return false;
   assertPriceReconfirmation(source,previous);
   const identity=r=>({shopId:r.shopId,productId:r.productId,historicalFingerprint:r.historicalFingerprint,previousApprovalId:r.previousApprovalId,kind:r.kind,source:r.source,type:r.type,rules:r.rules,durationMs:r.durationMs??null,activityLimit:r.activityLimit??null,campaignTarget:r.campaignTarget||null,skippedSkuIds:r.skippedSkuIds,rows:r.rows,key:r.key});
   return fingerprint(identity(review))===fingerprint(identity(source))&&review.rows.length===previous.rows.length&&!review.skippedSkuIds.length&&review.rows.every(row=>row.saleFen>=row.previousFen)&&review.type===previous.type&&fingerprint(review.rules)===fingerprint(previous.rules);
  }
  const source=review.dualSource;if(!source||c.sourceFingerprint!==fingerprint(source))return false;
  if(fingerprint(review.legacyPriceFloor||null)!==fingerprint(source.legacyPriceFloor||null))return false;
  if(source.legacyPriceFloor)validateLegacyPriceFloor(journal,source.plan,source.legacyPriceFloor,{requireCurrentTarget:false,now:review.approvedAt});
  if(source.probes.some(entry=>entry.task&&(entry.task.dualProbe?.grantId!==grant.id||fingerprint(entry.task.dualProbe?.choices)!==fingerprint(grant.choices))))return false;
  const decision=makeDualActivityDecision({plan:source.plan,probes:source.probes,now:source.createdAt,journal,...(source.scopeRestriction?{scopeRestriction:source.scopeRestriction}:{}),...(source.legacyPriceFloor?{legacyPriceFloor:source.legacyPriceFloor,priceFloorReplay:true}:{})}),scheme=decision.schemes.find(s=>s.type===review.type);
  if(decision.expiresAt<=review.approvedAt)return false;
  if(decision.pairKey!==source.pairKey||scheme?.classification!=='non-reducing'||!scheme.candidate)return false;
  const basis=scheme.review;
  return review.shopId===basis.shopId&&review.productId===basis.productId&&review.historicalFingerprint===basis.historicalFingerprint&&(review.previousApprovalId||null)===(basis.previousApprovalId||null)&&
   fingerprint(review.rows)===fingerprint(scheme.candidate.rows)&&review.rows.every(row=>row.saleFen>=row.previousFen&&row.saleFen===saleFen(row.baseFen,row.discount))&&fingerprint(review.campaignTarget||null)===fingerprint(basis.campaignTarget||null)&&fingerprint(review.rules)===fingerprint(basis.rules);
 }catch{return false;}
}
