import {fingerprint,normalizeName,requireThat,saleFen,validateHistorical,priceMode,priceModeFields,expectedSaleFen,assertSamePriceMode} from './policy.mjs';
import {successorLossKey,unresolvedOriginalFingerprint,validateRetiredTask} from './unresolved-recovery.mjs';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sorted=values=>[...values].sort();
const retiredReason='历史提交结果仍未知；已按本次明确恢复意图归档旧意图，非恢复成功，禁止重发原任务。';
const originalFrom=row=>({id:row.id,shopId:row.shop,phase:row.phase,updatedAt:row.updated,...JSON.parse(row.body)});
const sameIds=(a,b)=>fingerprint(sorted(a))===fingerprint(sorted(b));
export function initializeSubmissionArchives(db){
 db.exec(`CREATE TABLE IF NOT EXISTS submission_archives(
  id TEXT PRIMARY KEY, shop TEXT NOT NULL, task TEXT NOT NULL UNIQUE, original_row TEXT NOT NULL,
  original_fingerprint TEXT NOT NULL, closure TEXT NOT NULL, cycle_key TEXT NOT NULL, retired_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS submission_archives_shop_at ON submission_archives(shop,retired_at DESC);
  CREATE TABLE IF NOT EXISTS submission_successors(
  closure TEXT PRIMARY KEY REFERENCES submission_archives(id), task TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  plans_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, submitted_at INTEGER);
  CREATE TRIGGER IF NOT EXISTS submission_archives_no_update BEFORE UPDATE ON submission_archives BEGIN SELECT RAISE(ABORT,'submission archive is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS submission_archives_no_delete BEFORE DELETE ON submission_archives BEGIN SELECT RAISE(ABORT,'submission archive is immutable'); END;`);
}
function decode(journal,row){
 if(!row)return null;const originalRow=JSON.parse(row.original_row),closure=JSON.parse(row.closure),successor=journal.db.prepare('SELECT * FROM submission_successors WHERE closure=?').get(row.id);
 return{id:row.id,taskId:row.task,shopId:row.shop,original:originalFrom(originalRow),originalRow,closure,newCycleKey:row.cycle_key,retiredAt:row.retired_at,
  successor:successor?{taskId:successor.task,createdAt:successor.created_at,submittedAt:successor.submitted_at,plansFingerprint:successor.plans_fingerprint,task:journal.get(successor.task)}:null};
}
export const getSubmissionArchive=(journal,taskId)=>decode(journal,journal.db.prepare('SELECT * FROM submission_archives WHERE task=?').get(taskId));
export const getSubmissionArchiveByClosure=(journal,closureId)=>decode(journal,journal.db.prepare('SELECT * FROM submission_archives WHERE id=?').get(closureId));
export const listSubmissionArchives=(journal,shopId)=>journal.db.prepare('SELECT * FROM submission_archives WHERE shop=? ORDER BY retired_at DESC,id').all(shopId).map(row=>decode(journal,row));
function assertClosure(closure,original){
 requireThat(closure?.schema===1&&closure.source==='current-unresolved-recovery-retirement'&&hash(closure.id)&&hash(closure.key)&&closure.key===fingerprint({...closure,key:undefined})&&
  closure.shopId===original.shopId&&closure.taskId===original.id&&closure.originalTaskFingerprint===unresolvedOriginalFingerprint(original)&&
  closure.originalPhase===original.phase&&(closure.originalReason??null)===(original.reason??null)&&
  closure.historicalOutcome==='unknown'&&closure.success===false&&closure.marksOriginalRequestFailed===false&&closure.oldTaskMayRequeue===false&&closure.authorizesSubmit===false&&
  closure.requiresFreshLossAndPriceProofs===true&&closure.grantsNewPriceAuthority===false&&closure.noAutomaticReductions===true&&closure.noQuotaIncrease===true&&closure.maxSubmittedSuccessors===1,
  'UNRESOLVED_ARCHIVE','本次旧意图归档证明不完整或被修改');
 requireThat(Array.isArray(closure.productIds)&&sameIds(closure.productIds,original.plans.map(p=>p.productId))&&Array.isArray(closure.priceFloors)&&closure.priceFloors.length===original.plans.length,
  'UNRESOLVED_SCOPE','本次归档必须完整对应原任务所有商品');
 for(const plan of original.plans){const floors=closure.priceFloors.filter(p=>p.productId===plan.productId),floor=floors[0];
  requireThat(floors.length===1&&floor.type===plan.type&&priceMode(floor)===priceMode(plan)&&floor.historicalFingerprint===plan.historicalFingerprint&&Array.isArray(floor.skus)&&floor.skus.length===plan.skus.length&&
   sameIds(floor.skus.map(s=>s.id),plan.skus.map(s=>s.id))&&floor.skus.every(s=>plan.skus.some(p=>p.id===s.id&&p.baseFen===s.baseFen&&p.discount===s.discount&&p.saleFen===s.saleFen)),
   'UNRESOLVED_PRICE','归档价格边界与原任务完整规格不一致');
 }
}
export function retireUnresolvedSubmission(journal,taskId,retirement,now=Date.now()){
 requireThat(retirement?.allowed===true&&retirement.closure,'UNRESOLVED_ARCHIVE','只能保存本次完整核验通过的归档决定');
 const closure=retirement.closure;
 return journal.transaction(()=>{
  requireThat(!journal.db.prepare('SELECT 1 FROM submission_successors WHERE task=?').get(taskId),'UNRESOLVED_SUCCESSOR_SUBMITTED','本次新恢复若仍未知，只能回读，不能再归档以生成另一新恢复');
  const existing=getSubmissionArchive(journal,taskId);
  if(existing){assertClosure(closure,existing.original);requireThat(existing.closure.key===closure.key&&existing.newCycleKey===retirement.newCycleKey&&validateRetiredTask(existing.original,journal.get(taskId),closure).allowed,
   'UNRESOLVED_ARCHIVE_CHANGED','旧意图归档或原任务已变化，未重复归档');return existing;}
  const row=journal.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),original=row&&originalFrom(row);
  requireThat(original&&original.id===row.id&&original.shopId===row.shop&&original.phase===row.phase&&['unknown','submitting','verifying'].includes(row.phase),'UNRESOLVED_TASK','原任务已变化或不再是尚未核实的提交');
  assertClosure(closure,original);
  requireThat(Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(closure.at)&&closure.at<=now+5000&&now-closure.at<=600000&&Number.isSafeInteger(closure.consentExpiresAt)&&closure.consentExpiresAt>now&&
   (!closure.originalRowFingerprint||closure.originalRowFingerprint===fingerprint(row)), 'UNRESOLVED_ARCHIVE_CHANGED','原任务行或本次归档时效已变化');
  const expectedCycle=fingerprint({source:'current-unresolved-recovery-cycle',closureId:closure.id,taskId,originalTaskFingerprint:closure.originalTaskFingerprint});
  requireThat(retirement.newCycleKey===expectedCycle,'UNRESOLVED_CYCLE','新恢复生命周期未绑定原意图归档');
  const body=JSON.parse(row.body);body.reason=retiredReason;
  journal.db.prepare('INSERT INTO submission_archives VALUES(?,?,?,?,?,?,?,?)').run(closure.id,row.shop,row.id,JSON.stringify(row),closure.originalTaskFingerprint,JSON.stringify(closure),expectedCycle,now);
  const changed=journal.db.prepare('UPDATE tasks SET phase=?,body=?,updated=? WHERE id=? AND shop=? AND phase=? AND updated=? AND body=?').run('blocked',JSON.stringify(body),now,row.id,row.shop,row.phase,row.updated,row.body);
  requireThat(changed.changes===1,'UNRESOLVED_ARCHIVE_CHANGED','原提交记录在归档时变化');
  requireThat(validateRetiredTask(original,journal.get(taskId),closure).allowed,'UNRESOLVED_MATERIAL_CHANGED','归档不能改变原提交价格、计数或证明');
  journal.event(taskId,'unresolved-intent-retired',{shopId:row.shop,closureId:closure.id,historicalOutcome:'unknown',success:false,reason:retiredReason,originalFingerprint:closure.originalTaskFingerprint},now);
  return getSubmissionArchive(journal,taskId);
 });
}
export function submissionSuccessorMaterial(plans){
 return plans.map(p=>({...priceModeFields(p),shopId:p.shopId,productId:p.productId,historicalFingerprint:p.historicalFingerprint,type:p.type,rules:p.rules,durationMs:p.durationMs??null,
  activityLimit:p.activityLimit??null,priceApprovalId:p.priceApprovalId||null,priceApprovalKey:p.priceApprovalKey||null,campaignPolicyFingerprint:p.campaignPolicyFingerprint||null,
  campaignTarget:p.campaignTarget||null,productCampaignApprovalId:p.productCampaignApprovalId||null,skus:p.skus.map(s=>({id:s.id,name:normalizeName(s.name),baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.productId.localeCompare(b.productId));
}
function humanLoweringApproval(journal,plan,closure,now){
 const review=journal.priceTarget(plan.shopId,plan.productId);
 return !!review&&review.id===plan.priceApprovalId&&review.status==='approved'&&priceMode(review)===priceMode(plan)&&review.shopId===plan.shopId&&review.productId===plan.productId&&review.historicalFingerprint===plan.historicalFingerprint&&
  Number.isSafeInteger(review.approvedAt)&&review.approvedAt>=closure.at&&review.approvedAt<=now+5000&&review.consent?.exactPrices===true&&review.consent.matchedRiskConfirmation===true&&!review.automaticConsent&&!review.originalPriceConsent&&
  (review.approvalKind==null||['manual-human','manual','human'].includes(review.approvalKind))&&Array.isArray(review.rows)&&review.rows.length===plan.skus.length&&
  plan.skus.every(s=>review.rows.some(r=>r.id===s.id&&r.baseFen===s.baseFen&&r.discount===s.discount&&r.saleFen===s.saleFen));
}
function assertSuccessorPlans(journal,record,shopId,plans,now){
 const {closure,original}=record;assertClosure(closure,original);
 requireThat(Number.isSafeInteger(closure.consentExpiresAt)&&closure.consentExpiresAt>now,'UNRESOLVED_CONSENT_EXPIRED','本次明确的新恢复意图已过期，未沿用旧授权提交');
 requireThat(record.shopId===shopId&&validateRetiredTask(original,journal.get(record.taskId),closure).allowed,'UNRESOLVED_ARCHIVE_CHANGED','旧意图归档或原提交材料已变化');
 requireThat(plans.length===closure.productIds.length&&new Set(plans.map(p=>p.productId)).size===plans.length&&sameIds(plans.map(p=>p.productId),closure.productIds),'UNRESOLVED_SCOPE','一次新恢复必须完整匹配本次明确授权的商品范围');
 for(const plan of plans){
  const floor=closure.priceFloors.find(p=>p.productId===plan.productId),restriction=closure.allowedActivityTypesByProduct?.find(p=>p.productId===plan.productId),allowed=restriction?.allowedTypes||floor?.allowedTypes||closure.allowedTypes||[floor?.type];
  requireThat(plan.shopId===shopId&&floor&&plan.historicalFingerprint===floor.historicalFingerprint&&Array.isArray(allowed)&&allowed.includes(plan.type),'UNRESOLVED_TYPE_SCOPE','新恢复的店铺、历史或活动类型超出本次明确范围');
  const source=closure.sourceReferences?.find(p=>p.productId===plan.productId&&p.historicalFingerprint===floor.historicalFingerprint),histories=journal.histories(shopId).filter(b=>b.productId===plan.productId&&fingerprint(b)===floor.historicalFingerprint),baseline=histories[0];
  requireThat(histories.length===1&&source&&source.campaignId===baseline.campaignId&&source.type===baseline.type,'UNRESOLVED_SOURCE','原价格模板及来源指纹已变化，不能沿用本次新恢复授权');validateHistorical(baseline);
  assertSamePriceMode(plan,baseline);assertSamePriceMode(plan,floor);
  requireThat(Array.isArray(plan.skus)&&plan.skus.length===floor.skus.length&&new Set(plan.skus.map(s=>s.id)).size===plan.skus.length&&sameIds(plan.skus.map(s=>s.id),floor.skus.map(s=>s.id)),'UNRESOLVED_PRICE','新恢复必须保留本次完整规格集合');
  const target=journal.priceTarget(shopId,plan.productId),targetMatches=target?.historicalFingerprint===floor.historicalFingerprint,manual=humanLoweringApproval(journal,plan,closure,now);
  requireThat(!target||targetMatches,'UNRESOLVED_PRICE','当前批准目标的完整历史来源已变化');
  requireThat(targetMatches?plan.priceApprovalId===target.id:!plan.priceApprovalId,'UNRESOLVED_PRICE','新恢复必须使用当前明确批准的价格身份');
  for(const sku of plan.skus){const old=floor.skus.find(s=>s.id===sku.id),base=baseline.skus.find(s=>s.id===sku.id),approved=targetMatches?target.rows?.find(s=>s.id===sku.id):null;
   requireThat(old&&base&&old.baseFen===sku.baseFen&&base.baseFen===sku.baseFen&&normalizeName(base.name)===normalizeName(sku.name)&&
    sku.saleFen===expectedSaleFen(sku,plan)&&
    (approved?approved.baseFen===sku.baseFen&&approved.discount===sku.discount&&approved.saleFen===sku.saleFen:base.discount===sku.discount&&expectedSaleFen(base,baseline)===sku.saleFen)&&
    (sku.saleFen>=old.saleFen||manual),'UNRESOLVED_PRICE','新恢复不能自动低于原守护价；价格变化需要本次新的逐规格明确确认');
  }
  const bound=closure.quantityBounds?.find(b=>b.productId===plan.productId);
  if(bound)requireThat(plan.type==='限量抢购'&&bound.soldOut===false&&Number.isSafeInteger(bound.maxActivityLimit)&&bound.maxActivityLimit>0&&
   Number.isSafeInteger(plan.activityLimit)&&plan.activityLimit>0&&plan.activityLimit<=bound.maxActivityLimit,'UNRESOLVED_QUANTITY','新恢复不能补量、突破实际额度或借限时活动绕过限量约束');
  if(plan.type==='限量抢购')requireThat(restriction?.forbidNewLimitedQuota!==true&&bound,'UNRESOLVED_QUANTITY','没有本次明确的实际限量额度依据，不能新增限量活动');
 }
 journal.assertPricePlans(shopId,plans);
}
// Called inside enqueue's transaction. Missing flags are rejected for an open
// incident; no implicit permission is ever attached to an ordinary enqueue.
export function admitSubmissionSuccessor(journal,shopId,plans,lossEvidence,now=Date.now()){
 const closureId=lossEvidence?.unresolvedRecoveryClosureId,open=listSubmissionArchives(journal,shopId).filter(r=>r.successor?.task?.phase!=='verified'&&r.closure.productIds.some(id=>plans.some(p=>p.productId===id)));
 if(!closureId){requireThat(!open.length,'UNRESOLVED_CLOSURE_REQUIRED','本商品正在本次明确的新恢复范围内，须显式绑定归档生命周期');return null;}
 requireThat(typeof closureId==='string'&&hash(closureId),'UNRESOLVED_CYCLE','新恢复缺少有效归档身份');
 const record=getSubmissionArchiveByClosure(journal,closureId);requireThat(record,'UNRESOLVED_CYCLE','未找到本次明确归档的旧意图');
 requireThat(open.every(r=>r.id===closureId),'UNRESOLVED_CYCLE','本商品另有尚未完成的新恢复意图');assertSuccessorPlans(journal,record,shopId,plans,now);
 const plansFingerprint=fingerprint(submissionSuccessorMaterial(plans));
 if(record.successor)requireThat(record.successor.task&&record.successor.plansFingerprint===plansFingerprint&&fingerprint(submissionSuccessorMaterial(record.successor.task.plans))===plansFingerprint,
  'UNRESOLVED_SUCCESSOR_EXISTS','本次明确恢复已保留一个新任务；不为价格或结果变化另造第二次提交');
 return{record,plansFingerprint,prior:record.successor?.task||null,lossEvidence:{...lossEvidence,lossKey:successorLossKey(record.closure,lossEvidence.lossKey),unresolvedRecoveryClosureId:closureId}};
}
export function bindSubmissionSuccessor(journal,admission,taskId,now){
 if(!admission)return;
 journal.db.prepare('INSERT INTO submission_successors(closure,task,plans_fingerprint,created_at,submitted_at) VALUES(?,?,?,?,NULL)').run(admission.record.id,taskId,admission.plansFingerprint,now);
}
export function assertSubmissionSuccessorBoundary(journal,task,{consume=false,now=Date.now()}={}){
 if(!task)return;
 const mapping=journal.db.prepare('SELECT * FROM submission_successors WHERE task=?').get(task.id),flag=task.lossEvidence?.unresolvedRecoveryClosureId;
 const open=listSubmissionArchives(journal,task.shopId).filter(r=>r.successor?.task?.phase!=='verified'&&r.closure.productIds.some(id=>task.plans.some(p=>p.productId===id)));
 if(!mapping&&!flag){requireThat(!open.length,'UNRESOLVED_CLOSURE_REQUIRED','该商品的新恢复必须绑定本次明确意图，禁止绕过一次提交约束');return;}
 requireThat(mapping&&mapping.closure===flag,'UNRESOLVED_CYCLE','新恢复的任务与归档绑定不一致');
 const record=getSubmissionArchiveByClosure(journal,mapping.closure);requireThat(record&&record.successor?.taskId===task.id&&mapping.plans_fingerprint===fingerprint(submissionSuccessorMaterial(task.plans)),
  'UNRESOLVED_SUCCESSOR_EXISTS','本次新恢复任务材料已变化');assertSuccessorPlans(journal,record,task.shopId,task.plans,now);
 if(consume){requireThat(mapping.submitted_at==null&&task.submitAttempts===0&&task.riskAttempts===0&&task.submittedAt==null&&task.riskAttemptedAt==null&&task.draftProof==null&&task.riskProof==null&&task.receipt==null,
   'UNRESOLVED_SUCCESSOR_SUBMITTED','本次明确的新恢复已经记录主提交，未知结果只能回读');
  requireThat(journal.db.prepare('UPDATE submission_successors SET submitted_at=? WHERE closure=? AND task=? AND submitted_at IS NULL').run(now,mapping.closure,task.id).changes===1,'UNRESOLVED_SUCCESSOR_SUBMITTED','本次明确的新恢复提交权已被使用');
 }else requireThat(mapping.submitted_at==null||task.submitAttempts===1&&task.submittedAt===mapping.submitted_at,'UNRESOLVED_SUCCESSOR_SUBMITTED','新恢复的持久主提交计数与一次提交证明不一致');
}
