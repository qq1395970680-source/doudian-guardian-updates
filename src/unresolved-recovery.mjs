import {fingerprint,id,requireThat,proveDraft,proveOriginalRisk,saleFen,validateHistorical} from './policy.mjs';
import {assessSubmissionQuery,adjudicateSubmissionInvestigation,submissionTaskFingerprint,officialQueryCoverage} from './submission-investigation.mjs';
import {campaignChoice} from './campaign-choice.mjs';

// Pure incident authorization and proof validation. These functions do not
// write a Journal, clear a task, authorize prices or click a platform control.
export const UNRESOLVED_SETTLEMENT_WAIT_MS=3600000;
export const UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS=600000;
const lifetime=86400000,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fresh=(at,now)=>Number.isSafeInteger(at)&&at>0&&at<=now+5000&&now-at<=120000;
const reject=(code,reason)=>({allowed:false,code,reason});
export const unresolvedOriginalFingerprint=task=>fingerprint(task);
const products=task=>[...new Set(task.plans.map(p=>p.productId))].sort();
const priceFloors=task=>task.plans.map(p=>({productId:p.productId,type:p.type,historicalFingerprint:p.historicalFingerprint,
 activityLimit:p.activityLimit??null,skus:p.skus.map(s=>({id:s.id,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.productId.localeCompare(b.productId));
function assertTask(task){
 requireThat(task&&typeof task.id==='string'&&task.id&&['unknown','submitting','verifying'].includes(task.phase),'UNRESOLVED_TASK','只处理明确尚未核实的原任务');
 id(task.shopId);requireThat(task.submitAttempts===1&&[0,1].includes(task.riskAttempts)&&Array.isArray(task.plans)&&task.plans.length>0,'UNRESOLVED_BOUNDARY','原提交计数或完整计划缺失');
 requireThat(task.plans.every(p=>p.shopId===task.shopId&&typeof p.productId==='string'&&Array.isArray(p.skus)&&p.skus.length)&&new Set(task.plans.map(p=>p.productId)).size===task.plans.length,'UNRESOLVED_SCOPE','原任务商品范围不完整或跨店');
 for(const p of task.plans){id(p.productId);requireThat(['限时抢购','限量抢购'].includes(p.type)&&hash(p.historicalFingerprint)&&new Set(p.skus.map(s=>s.id)).size===p.skus.length,'UNRESOLVED_SCOPE','原活动类型、历史或规格身份缺失');
  for(const s of p.skus){id(s.id);requireThat(Number.isSafeInteger(s.baseFen)&&s.baseFen>0&&Number.isInteger(s.discount)&&s.discount>0&&s.discount<=100&&s.saleFen===saleFen(s.baseFen,s.discount),'UNRESOLVED_PRICE','原任务价格材料不完整');}}
 const proof=task.draftProof;requireThat(proof&&Number.isSafeInteger(proof.at)&&proof.at>0&&Number.isSafeInteger(task.submittedAt)&&task.submittedAt>=proof.at&&task.submittedAt-proof.at<=30000,'UNRESOLVED_DRAFT','缺少持久绑定的原提交草稿');
 requireThat(!task.receipt,'UNRESOLVED_RECEIPT','已有原提交回执线索，须先按活动编号核实，不能按查无归档');
 const verified=proveDraft(task,proof.observation,proof.at);
 requireThat(verified.materialFingerprint===proof.materialFingerprint&&verified.plansFingerprint===proof.plansFingerprint,'UNRESOLVED_DRAFT','持久提交证明与原计划不一致');
 if(task.riskAttempts===0)requireThat(task.riskAttemptedAt==null&&task.riskProof==null,'UNRESOLVED_RISK','风险计数与原证明矛盾，须先核实');
 else{const risk=task.riskProof;requireThat(risk?.taskId===task.id&&risk.kind==='original-discount-risk'&&Number.isSafeInteger(risk.at)&&risk.at===task.riskAttemptedAt&&risk.at>=task.submittedAt,'UNRESOLVED_RISK','原风险确认计数缺少完整绑定证明');proveOriginalRisk({...task,riskAttempts:0},risk.observation,risk.at);}
}
export function consentForTasks(tasks,{shopId,runtimeId,authorizationRef,acceptHistoricalUnknown=false,acceptOneNewLifecycle=false,noPriceReductions=false,noQuotaIncrease=false,at,expiresAt}={},now=Date.now()){
 at??=now;expiresAt??=at+lifetime;
 id(shopId);requireThat(typeof runtimeId==='string'&&runtimeId.length>=8&&typeof authorizationRef==='string'&&authorizationRef.trim().length>=8,'UNRESOLVED_CONSENT','缺少本机及本次明确恢复指令来源');
 requireThat(acceptHistoricalUnknown===true&&acceptOneNewLifecycle===true&&noPriceReductions===true&&noQuotaIncrease===true,'UNRESOLVED_CONSENT','须明确保留历史未知，只允许一次新恢复且不授予降价或补量');
 requireThat(Number.isSafeInteger(at)&&at>0&&at<=now+5000&&Number.isSafeInteger(expiresAt)&&expiresAt>now&&expiresAt>at&&expiresAt-at<=lifetime,'UNRESOLVED_CONSENT_TIME','本次授权时间无效或超过一天');
 requireThat(Array.isArray(tasks)&&tasks.length>0&&new Set(tasks.map(t=>t.id)).size===tasks.length,'UNRESOLVED_CONSENT_SCOPE','须逐笔明确本次原任务');
 const scopes=tasks.map(task=>{assertTask(task);requireThat(task.shopId===shopId,'SHOP_MISMATCH','本次授权不能跨店');return{taskId:task.id,originalTaskFingerprint:unresolvedOriginalFingerprint(task),submissionTaskFingerprint:submissionTaskFingerprint(task),productIds:products(task),priceFloors:priceFloors(task)};}).sort((a,b)=>a.taskId.localeCompare(b.taskId));
 const value={schema:1,source:'human-current-unresolved-recovery-intent',shopId,runtimeId,authorizationRef:authorizationRef.trim(),at,expiresAt,scopes,
  historicalOutcome:'unknown',oneSubmittedSuccessor:true,noPriceReductions:true,noQuotaIncrease:true,grantsNewPriceAuthority:false};
 return{...value,key:fingerprint(value)};
}
export function validateUnresolvedRecoveryConsent(consent,task,{runtimeId,now=Date.now()}={}){
 try{assertTask(task);}catch(error){return reject(error.code||'UNRESOLVED_TASK',error.message);}
 if(consent?.schema!==1||consent.source!=='human-current-unresolved-recovery-intent'||!hash(consent.key)||consent.key!==fingerprint({...consent,key:undefined})||consent.shopId!==task.shopId||typeof runtimeId!=='string'||runtimeId.length<8||consent.runtimeId!==runtimeId||typeof consent.authorizationRef!=='string'||consent.authorizationRef.length<8||!Array.isArray(consent.scopes)||consent.historicalOutcome!=='unknown'||consent.oneSubmittedSuccessor!==true||consent.noPriceReductions!==true||consent.noQuotaIncrease!==true||consent.grantsNewPriceAuthority!==false)return reject('UNRESOLVED_CONSENT','本机、本店或本次明确恢复授权不完整');
 if(!Number.isSafeInteger(consent.at)||consent.at<=0||consent.at>now+5000||!Number.isSafeInteger(consent.expiresAt)||consent.expiresAt<=now||consent.expiresAt<=consent.at||consent.expiresAt-consent.at>lifetime)return reject('UNRESOLVED_CONSENT_EXPIRED','本次恢复授权已过期或时间不合法');
 const scope=consent.scopes.filter(s=>s.taskId===task.id);if(scope.length!==1||scope[0].originalTaskFingerprint!==unresolvedOriginalFingerprint(task)||fingerprint(scope[0].productIds)!==fingerprint(products(task))||fingerprint(scope[0].priceFloors)!==fingerprint(priceFloors(task)))return reject('UNRESOLVED_TASK_CHANGED','原任务、价格、规格、计数或证明已变化，不能沿用授权');
 return{allowed:true,scope:scope[0]};
}
function coverage(listing,task,query,context,now,{maxAgeMs=120000,minObservedAt=null}={}){
 const assessed=assessSubmissionQuery(listing,query,task,now,{maxAgeMs,minObservedAt});if(!assessed.complete)return reject('UNRESOLVED_QUERY_INCOMPLETE',assessed.code+'：'+assessed.reason);
 const range=task.draftProof.observation,from=Math.min(task.submittedAt,range.startAt),to=Math.max(now,range.endAt),d=assessed.dateCoverage;
 let dates=d.state==='unbounded-visible'||d.state==='bounded'&&d.startAt<=from&&d.endAt>=to;
 const supplied=context.coverageProofs?.find(p=>p.listingFingerprint===fingerprint(listing));
 const derived=officialQueryCoverage(listing,{referenceListings:context.coverageReferenceListings||[],now,maxAgeMs,referenceMaxAgeMs:UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS,minObservedAt});
 if(supplied&&(derived.complete!==true||!supplied.evidence||supplied.evidenceFingerprint!==fingerprint(supplied.evidence)||supplied.source!==derived.source||supplied.shopId!==derived.shopId||supplied.allDates!==derived.allDates||fingerprint(supplied.activityTypes)!==fingerprint(derived.activityTypes)))return reject('UNRESOLVED_QUERY_COVERAGE','外部范围证明无法从本次官方筛选面及实际跨统计日期活动重放核实');
 if(derived.complete===true)dates||=derived.allDates===true;
 if(!dates)return reject('UNRESOLVED_DATE_SCOPE','日期范围未覆盖原提交和潜在生效窗口；须补官方完整筛选面或响应范围证明');
 // A reset visible list with all recognized activity choices, or separately
 // captured official query coverage, must establish both promotion types.
 const types=listing.queryScope?.activityTypes||(derived.complete?derived.activityTypes:null);
 if(!Array.isArray(types)||types.length!==2||!['限时抢购','限量抢购'].every(t=>types.includes(t)))return reject('UNRESOLVED_TYPE_SCOPE','尚未证明查询同时覆盖限时和限量活动');
 return{allowed:true};
}
const historicalFresh=(at,raw)=>Number.isSafeInteger(at)&&at>=raw.startedAt&&at<=raw.finishedAt+5000&&raw.finishedAt-at<=UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS;
function assessRaw(task,raw,context,now,{latest=false}={}){
 if(raw?.diagnosticOnly!==true||raw.authorizesSubmit!==false||raw.mode!=='complete-investigation'||!Number.isSafeInteger(raw.finishedAt)||raw.finishedAt>now+5000||now-raw.finishedAt>UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS||!Number.isSafeInteger(raw.startedAt)||raw.startedAt>raw.finishedAt||now-raw.startedAt>UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS||raw.candidateConflicts?.length)return reject('UNRESOLVED_INVESTIGATION','完整调查缺失、超过十分钟或候选身份发生变化');
 const readAt=raw.finishedAt,assessment=adjudicateSubmissionInvestigation(task,raw,{now:readAt});
 if(assessment.classification!=='not-found')return reject('UNRESOLVED_ORIGINAL_CANDIDATE','原任务仍有同名候选、读取错误或匹配歧义，须先处理该项事实：'+assessment.reason);
 const coverageContext={...context,coverageReferenceListings:[raw.titleQuery?.listing,...(raw.productQueries||[]).map(q=>q.listing),...(raw.referenceQueries||[]).map(q=>q.listing)].filter(Boolean)};
 const title=coverage(raw.titleQuery?.listing,task,{productId:null,title:task.title,status:null},coverageContext,readAt,{maxAgeMs:UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS,minObservedAt:raw.startedAt});if(!title.allowed)return title;
 for(const plan of task.plans)for(const status of [null,'进行中','未开始']){
  const records=raw.productQueries?.filter(q=>q.productId===plan.productId&&q.status===status);if(records?.length!==1||records[0].error)return reject('UNRESOLVED_PRODUCT_QUERY','每件商品须有独立全状态、进行中及未开始的完整查询');
  const record=records[0],checked=coverage(record.listing,task,{productId:plan.productId,title:null,status},coverageContext,readAt,{maxAgeMs:status===null?UNRESOLVED_INVESTIGATION_TIME_LIMIT_MS:120000,minObservedAt:raw.startedAt});if(!checked.allowed)return checked;
  if(latest&&status!==null&&!fresh(record.listing.observedAt,now))return reject('UNRESOLVED_CURRENT_STALE','最后当前及未开始商品查询超过两分钟，创建新生命周期前须重新读取');
  for(const c of record.listing.campaigns){
   const entries=raw.details?.filter(d=>d.campaignId===c.id),entry=entries?.[0],d=entry?.detail;
   if(entries?.length!==1||entry.shopId!==task.shopId||entry.error||!d?.complete||!historicalFresh(d.observedAt,raw)||!Array.isArray(d.products)||new Set(d.products.map(p=>p.productId)).size!==d.products.length||entry.campaign&&fingerprint(entry.campaign)!==fingerprint(c))return reject('UNRESOLVED_CANDIDATE_DETAIL','候选活动详情、身份或本轮十分钟历史读取范围尚未完整核实');
   if(!['进行中','未开始','已失效','已结束','已作废'].includes(c.status))return reject('UNRESOLVED_PENDING_CREATION','候选包含未识别或可能仍在创建、审核、续期的状态');
   const member=d.products.find(p=>p.productId===plan.productId);
   if(member?.removalAmbiguous)return reject('UNRESOLVED_MEMBERSHIP','商品当前归属仍有歧义');
   if(['进行中','未开始'].includes(c.status)&&member&&!member.removalConfirmed)return reject('UNRESOLVED_CURRENT_ACTIVITY','商品已有当前或未开始活动，禁止新建');
   // Renamed exact material is an investigation lead, never title absence.
   if(c.type===plan.type&&c.startAt===task.draftProof.observation.startAt&&c.endAt===task.draftProof.observation.endAt&&member&&!member.removalConfirmed)return reject('UNRESOLVED_POSSIBLE_ORIGINAL','发现原提交时段和商品相符的改名候选，先核实原来源');
  }
 }
 return{allowed:true};
}
function quantityBounds(task,raw,context,now){
 const bounds=[],sources=[],restrictions=[];
 const g=context.activityGrant,types=['限时抢购','限量抢购'];
 if(g&&(g.schema!==1||g.shopId!==task.shopId||g.source!=='human-app-dual-activity-consent'||g.mode!=='both-types-original-first-no-reductions'||g.allowBothActivityTypes!==true||g.allowMatchedRisk!==true||!Number.isSafeInteger(g.at)||g.at<=0||g.at>now+5000||g.key!==fingerprint({...g,key:undefined})||fingerprint(g.choices)!==fingerprint(types.map(campaignChoice))))return reject('UNRESOLVED_ACTIVITY_AUTHORITY','不能用未经当前授权核实的活动类型扩大恢复范围');
 for(const plan of task.plans){
  const baselines=context.histories?.filter(b=>b.shopId===task.shopId&&b.productId===plan.productId&&fingerprint(b)===plan.historicalFingerprint);
  if(baselines?.length!==1)return reject('UNRESOLVED_SOURCE','缺少原计划指向的唯一完整历史来源，不能盲退更早活动');
  const baseline=baselines[0];validateHistorical(baseline);sources.push({productId:plan.productId,historicalFingerprint:plan.historicalFingerprint,campaignId:baseline.campaignId,type:baseline.type,kind:'price-template'});
  const losses=(task.lossEvidence?.priceRules||[]).map(r=>r.removalEvidence).filter(e=>e?.source==='live-platform-removal-export'&&e.record?.productId===plan.productId&&['限时抢购','限量抢购'].includes(e.activityType));
  for(const e of losses)sources.push({productId:plan.productId,historicalFingerprint:plan.historicalFingerprint,campaignId:e.campaignId,type:e.activityType,kind:'recorded-loss'});
  const sourceIds=new Set([baseline.campaignId,...losses.map(e=>e.campaignId)]);
  const refs=raw.referenceQueries?.filter(r=>r.productId===plan.productId&&r.historicalFingerprint===plan.historicalFingerprint&&!r.error)||[];
  if(refs.some(r=>!sourceIds.has(r.sourceCampaignId)))return reject('UNRESOLVED_SOURCE','实际来源既非原价格模板也非原任务记录的失效来源');
  // Recorded loss sources can already be present in a complete product
  // query, without a separate referenceQueries lookup. Join ONLY identities
  // persisted in the original task; never borrow a later unrelated quota.
  const actual=[];
  for(const cid of sourceIds){
   const entries=raw.details?.filter(d=>d.campaignId===cid)||[];
   if(entries.length>1)return reject('UNRESOLVED_SOURCE_DETAIL','原来源存在重复详情，不能任取一条作为数量依据');
   const entry=entries[0];if(!entry)continue;
   const expectedTypes=new Set([...(cid===baseline.campaignId?[baseline.type]:[]),...losses.filter(e=>e.campaignId===cid).map(e=>e.activityType)]);
   if(expectedTypes.size!==1||entry.shopId!==task.shopId||entry.error||!entry.detail?.complete||entry.campaign?.id!==cid||!expectedTypes.has(entry.campaign.type))return reject('UNRESOLVED_SOURCE_DETAIL','原来源详情的店铺、活动类型或完整性不一致');
   actual.push(entry);
  }
  const limited=actual.filter(d=>d.campaign?.type==='限量抢购');
  const genuineLimited=baseline.type==='限量抢购'||losses.some(e=>e.activityType==='限量抢购')||limited.length>0;
  let allowedTypes=g?[...types]:[plan.type];
  if(plan.type!=='限量抢购'&&!genuineLimited){restrictions.push({productId:plan.productId,allowedTypes,forbidNewLimitedQuota:false,sourceCampaignId:losses.at(-1)?.campaignId||baseline.campaignId,sourceHistoricalFingerprint:plan.historicalFingerprint,reason:'保留当前已授权活动范围'});continue;}
  const explicit=context.quantityProofs?.filter(p=>p.productId===plan.productId)||[];
  let bound=null;
  for(const entry of limited){
   const detail=entry.detail,member=detail.products?.find(p=>p.productId===plan.productId),campaign=entry.campaign;
   if(!fresh(detail.observedAt,raw.finishedAt)||member?.soldOut!==false||member.removalAmbiguous||campaign.status==='已作废'||!Number.isSafeInteger(member.activityLimit)||member.activityLimit<1||member.activityLimit>1000)continue;
   const p=explicit.find(p=>p.source==='live-platform-limited-quota'&&p.complete===true&&p.shopId===task.shopId&&p.campaignId===entry.campaignId&&p.historicalFingerprint===plan.historicalFingerprint&&p.evidenceFingerprint===fingerprint({campaign,detail})&&p.observedAt===detail.observedAt&&fresh(p.observedAt,now));
   // Explicit proof names the actual source; it cannot override its soldOut.
   if(!p||p.soldOut!==false||p.activityLimit!==member.activityLimit)continue;
   const maximum=p.remainingQuota==null?member.activityLimit:p.remainingQuota;
   if(!Number.isSafeInteger(maximum)||maximum<1||maximum>member.activityLimit||plan.type==='限量抢购'&&plan.activityLimit>maximum)continue;
   bound={productId:plan.productId,sourceCampaignId:entry.campaignId,maxActivityLimit:maximum,sourceActivityLimit:member.activityLimit,soldOut:false,evidenceFingerprint:p.evidenceFingerprint};
  }
  if(!bound){
   if(!genuineLimited&&baseline.type==='限时抢购'&&plan.type==='限量抢购'){
    const required=[baseline.campaignId,...losses.map(e=>e.campaignId)];
    if(!required.every(cid=>actual.some(e=>e.campaignId===cid&&e.campaign?.type==='限时抢购'&&historicalFresh(e.detail.observedAt,raw))))return reject('UNRESOLVED_SOURCE_DETAIL','仅限时恢复仍须读取实际限时模板及原失效来源，不能把缺失来源当作无限量约束');
    restrictions.push({productId:plan.productId,allowedTypes:['限时抢购'],forbidNewLimitedQuota:true,sourceCampaignId:losses.at(-1)?.campaignId||baseline.campaignId,sourceHistoricalFingerprint:plan.historicalFingerprint,reason:'原实际来源为限时；旧未知限量计划无额度确证，本次禁止新建限量额度，仅可按有效价格授权核验限时'});continue;
   }
   return reject('UNRESOLVED_QUANTITY','限量来源、未售罄和额度依据不足；不能补量或改走限时绕过数量限制');
  }
  allowedTypes=allowedTypes.filter(type=>type==='限量抢购');
  if(!allowedTypes.length)return reject('UNRESOLVED_ACTIVITY_AUTHORITY','实际来源须保留限量上限，本次尚未明确允许限量恢复；不能改走限时绕过额度');
  bounds.push(bound);
  restrictions.push({productId:plan.productId,allowedTypes,forbidNewLimitedQuota:false,preserveLimitedQuota:true,sourceCampaignId:bound.sourceCampaignId,sourceHistoricalFingerprint:plan.historicalFingerprint,reason:'实际限量来源及未售罄额度已核实，仅允许在该上限内恢复限量活动，不能改走限时绕过额度'});
 }
 return{allowed:true,bounds,sources,restrictions};
}
function retirementChecked(task,investigation,consent,context={}){
 const now=context.now??Date.now(),validated=validateUnresolvedRecoveryConsent(consent,task,{runtimeId:context.runtimeId,now});if(!validated.allowed)return validated;
 const lastIntent=Math.max(task.submittedAt||0,task.riskAttemptedAt||0);
 if(!Number.isSafeInteger(now)||now-lastIntent<UNRESOLVED_SETTLEMENT_WAIT_MS)return reject('UNRESOLVED_SETTLEMENT','尚未经过原动作收尾冷却期；时间本身也不证明原请求失败');
 const actor=context.actorExit;
 if(actor?.source!=='owned-process-tree-exit'||actor.complete!==true||actor.shopId!==task.shopId||actor.taskFingerprint!==submissionTaskFingerprint(task)||actor.allExited!==true||actor.currentDraftAbsent!==true||!Number.isSafeInteger(actor.observedAt)||actor.observedAt<lastIntent||actor.observedAt>now+5000||!Array.isArray(actor.processIds)||!actor.processIds.length||actor.processIds.some(p=>!Number.isSafeInteger(p)||p<=0)||new Set(actor.processIds).size!==actor.processIds.length)return reject('UNRESOLVED_ACTOR','未证明原执行进程及专用浏览器已退出且当前无原草稿可继续点击');
 const raws=Array.isArray(investigation)?investigation:[context.previousInvestigation,investigation];
 if(raws.length!==2||!raws[0]||!raws[1]||raws[0].finishedAt>raws[1].startedAt||raws[0].startedAt===raws[1].startedAt)return reject('UNRESOLVED_STABLE_READS','须保留两次顺序独立完成的完整调查');
 if(actor.observedAt>raws[0].startedAt)return reject('UNRESOLVED_ACTOR','当前缺失调查必须在原执行进程已确认退出之后进行');
 for(const [index,raw] of raws.entries()){const checked=assessRaw(task,raw,context,now,{latest:index===raws.length-1});if(!checked.allowed)return checked;}
 const quantity=quantityBounds(task,raws[1],context,now);if(!quantity.allowed)return quantity;
 const allowedTypes=['限时抢购','限量抢购'].filter(type=>quantity.restrictions.every(r=>r.allowedTypes.includes(type)));
 if(!allowedTypes.length)return reject('UNRESOLVED_ACTIVITY_SCOPE','本次完整原任务没有同时获准的活动类型，不能只归档部分商品');
 const originalTaskFingerprint=unresolvedOriginalFingerprint(task),id=fingerprint({source:'current-unresolved-recovery-retirement',taskId:task.id,originalTaskFingerprint,consentKey:consent.key});
 const closure={schema:1,id,source:'current-unresolved-recovery-retirement',shopId:task.shopId,taskId:task.id,runtimeId:context.runtimeId,
  historicalOutcome:'unknown',success:false,marksOriginalRequestFailed:false,oldTaskMayRequeue:false,originalPhase:task.phase,originalReason:task.reason??null,
  originalTaskFingerprint,originalRowFingerprint:hash(context.originalRowFingerprint)?context.originalRowFingerprint:null,submissionTaskFingerprint:submissionTaskFingerprint(task),
  consentKey:consent.key,consentExpiresAt:consent.expiresAt,authorizationRef:consent.authorizationRef,productIds:products(task),priceFloors:structuredClone(validated.scope.priceFloors).map(p=>({...p,allowedTypes:quantity.restrictions.find(r=>r.productId===p.productId).allowedTypes})),quantityBounds:quantity.bounds,sourceReferences:quantity.sources,
  allowedTypes,allowedActivityTypesByProduct:structuredClone(quantity.restrictions),perProduct:structuredClone(quantity.restrictions),forbidNewLimitedQuota:quantity.restrictions.some(r=>r.forbidNewLimitedQuota),activityGrantKey:context.activityGrant?.key||null,
  authorizesSubmit:false,requiresFreshLossAndPriceProofs:true,grantsNewPriceAuthority:false,noAutomaticReductions:true,noQuotaIncrease:true,maxSubmittedSuccessors:1,actorExitFingerprint:fingerprint(actor),investigationFingerprints:raws.map(fingerprint),at:now};
 const newCycleKey=fingerprint({source:'current-unresolved-recovery-cycle',closureId:id,taskId:task.id,originalTaskFingerprint});
 return{allowed:true,code:'UNRESOLVED_NEW_CURRENT_INTENT',reason:'旧提交结果仍未知；已按本次明确意图和完整当前证据归档旧意图，允许另建一次受原价格与数量约束的新恢复生命周期',closure:{...closure,key:fingerprint(closure)},newCycleKey};
}
export function makeRetirement(task,investigation,consent,context={}){
 try{return retirementChecked(task,investigation,consent,context);}catch(error){return reject(error.code||'UNRESOLVED_EVIDENCE_INVALID',error.message||'调查结构不完整，保留原未知');}
}
export function successorLossKey(closure,currentLossKey){
 requireThat(closure?.source==='current-unresolved-recovery-retirement'&&closure.key===fingerprint({...closure,key:undefined})&&closure.historicalOutcome==='unknown'&&closure.success===false&&typeof currentLossKey==='string'&&currentLossKey.length>0,'UNRESOLVED_CYCLE','缺少有效旧意图归档或当前失效证明');
 return fingerprint({source:'current-unresolved-recovery-loss',closureId:closure.id,originalTaskFingerprint:closure.originalTaskFingerprint,currentLossKey});
}
export function validateRetiredTask(original,current,closure){
 if(!closure||closure.originalTaskFingerprint!==unresolvedOriginalFingerprint(original)||closure.key!==fingerprint({...closure,key:undefined})||closure.historicalOutcome!=='unknown'||closure.success!==false||current?.phase!=='blocked')return reject('UNRESOLVED_ARCHIVE','旧原文归档或非成功终态不一致');
 const material=t=>{const {phase,updatedAt,reason,...body}=t;return body;};
 if(fingerprint(material(original))!==fingerprint(material(current)))return reject('UNRESOLVED_MATERIAL_CHANGED','旧ID、计划、计数、回执或提交证明发生变化');
 return{allowed:true};
}
