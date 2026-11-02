import {activeCareRecoveryGrant,carePriceCandidate,careSourceEvidence,validCarePriceApproval} from './care-recovery-policy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint, normalizeName, requireThat, validateHistorical, proveDraft, proveOriginalRisk, saleFen } from './policy.mjs';
import {activePriceIncreaseGrant,isAutomaticPriceIncrease,validAutomaticPriceApproval} from './price-increase-policy.mjs';
import {assertCampaignPolicy} from './campaign-policy.mjs';
import {makeRemovalPriceReview} from './ratio-prices.mjs';
import {blockerPriceOptions,activityPriceBasis} from './activity-price-comparison.mjs';
import {manualPriceOption} from './manual-price-option.mjs';
import {priceOptions} from './price-options.mjs';
import {makePriceReconfirmation,assertPriceReconfirmation,needsPriceReconfirmation} from './price-reconfirmation.mjs';
import {assertRecoveryCapacity} from './recovery-capacity.mjs';
import {makeRebuildReview,rebuildMaterial} from './rebuild-review.mjs';
import {requestRecovery,recoveryRequests} from './recovery-requests.mjs';
import {buildRecheckProgress} from './recheck-progress.mjs';
import {assertOriginalRebuildConsent} from './original-rebuild-policy.mjs';
import {activeOriginalPriceRecoveryGrant,validOriginalPriceApproval} from './original-price-recovery-policy.mjs';
import {makeHistoryReconfirmation,assertHistoryReconfirmation} from './history-reconfirmation.mjs';
import {lastInactiveProductEvidence,explicitOnShelfState} from './catalog-visibility.mjs';

const transitions = {
  queued: ['prepared', 'blocked'], prepared: ['submitting', 'blocked'],
  submitting: ['verifying', 'unknown'], unknown: ['verifying', 'verified', 'blocked'],
  verifying: ['verified', 'unknown', 'blocked'], blocked: ['queued'], verified: []
};
const restartBlockReason='pre-submit-proof-expired-on-restart';
const priceViewExpiry=at=>Number.isSafeInteger(at)&&at>0?
 {sql:" AND (state NOT IN ('pending','declined') OR json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?)",params:[at]}:{sql:'',params:[]};
const knownUnsubmitted=task=>task?.submitAttempts===0&&task.riskAttempts===0&&
  task.submittedAt==null&&task.riskAttemptedAt==null&&task.draftProof==null&&task.riskProof==null&&task.receipt==null;
export class Journal {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, shop TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baselines(shop TEXT NOT NULL, product TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(shop,product,hash));
      CREATE TABLE IF NOT EXISTS settings(shop TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(shop TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS product_checks(shop TEXT NOT NULL, product TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(shop,product));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS price_reviews(id TEXT PRIMARY KEY, shop TEXT NOT NULL, product TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS price_targets(shop TEXT NOT NULL, product TEXT NOT NULL, review TEXT NOT NULL, PRIMARY KEY(shop,product));
      CREATE INDEX IF NOT EXISTS price_reviews_shop_state_updated ON price_reviews(shop,state,updated DESC);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(task, kind, detail, now = Date.now()) {
    const body=this.diagnosticContext?{...detail,runtimeBuild:this.diagnosticContext}:detail;
    this.db.prepare('INSERT INTO events(task,at,kind,body) VALUES(?,?,?,?)').run(task, now, kind, JSON.stringify(body));
  }
  setDiagnosticContext({version,sourceBuild,instance,startedAt}){
    requireThat(/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)&&/^[a-f0-9]{64}$/.test(sourceBuild)&&/^[a-f0-9]{32}$/.test(instance)&&Number.isSafeInteger(startedAt)&&startedAt>0,
      'DIAGNOSTIC_BUILD','运行版本来源不完整');
    this.diagnosticContext=Object.freeze({version,sourceBuild,instance,startedAt});
  }
  get(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    return row ? { id: row.id, shopId: row.shop, phase: row.phase, updatedAt: row.updated, ...JSON.parse(row.body) } : null;
  }
  list(shopId) { return this.db.prepare('SELECT id FROM tasks WHERE shop=? ORDER BY updated DESC').all(shopId).map(row => this.get(row.id)); }
  enqueue(shopId, plans, lossEvidence, now = Date.now()) {
    requireThat(plans.length && plans.every(p => p.shopId === shopId), 'SHOP_MISMATCH', '任务不能跨店');
    assertRecoveryCapacity(plans);
    requireThat(lossEvidence?.complete === true && lossEvidence.observedAt > 0 && now-lossEvidence.observedAt<=120000 && lossEvidence.observedAt<=now+5000 &&
      typeof lossEvidence.lossKey==='string' && lossEvidence.lossKey.length>0, 'LOSS_UNPROVEN', '缺少当前活动失效证明');
    const dedupe = fingerprint({ shopId, plans: plans.map(p => [p.productId, p.historicalFingerprint, p.skus,
      ...(p.type==='限量抢购'?[p.type,p.rules,p.activityLimit,p.durationMs,p.campaignPolicyFingerprint||null]:p.durationMs!=null?[p.type,p.rules,p.durationMs,p.campaignPolicyFingerprint||null]:[])]), loss: lossEvidence.lossKey });
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id FROM tasks WHERE dedupe=?').get(dedupe);
      if (prior) return this.get(prior.id);
      const pending = this.list(shopId).filter(t => !['verified', 'blocked'].includes(t.phase));
      requireThat(!pending.some(t => t.plans.some(p => plans.some(q => q.productId === p.productId))), 'PENDING', '商品已有未完成任务');
      const taskId = randomUUID(), discounts=[...new Set(plans.flatMap(p=>p.skus.map(s=>s.discount)))].sort((a,b)=>a-b);
      const label=plans.every(p=>p.type==='限量抢购')?(discounts.length===1?String(discounts[0]/10)+'折':'多折扣')+'-':'';
      const title = '守护2-' + label + taskId.replaceAll('-', '').slice(0, label?12:18);
      const body = { title, plans, lossEvidence, createdAt: now, submitAttempts: 0, riskAttempts: 0 };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId, shopId, dedupe, 'queued', JSON.stringify(body), now);
      this.event(taskId, 'queued', { products: plans.map(p => p.productId) }, now);
      return this.get(taskId);
    });
  }
  transition(taskId, expected, phase, patch = {}, now = Date.now()) {
    return this.transaction(() => {
      const task = this.get(taskId);
      requireThat(task && task.phase === expected && transitions[expected]?.includes(phase), 'JOURNAL_TRANSITION', '任务状态已变化或不允许该操作');
      if(expected==='blocked')requireThat(knownUnsubmitted(task)&&task.retryAfter>0&&task.retryAfter<=now,'RETRY_FORBIDDEN','只能重试主提交和风险确认均明确为零且已到重试时间的任务');
      const { id, shopId, phase: oldPhase, updatedAt, ...body } = task;
      Object.assign(body, patch);
      this.db.prepare('UPDATE tasks SET phase=?,body=?,updated=? WHERE id=? AND phase=?').run(phase, JSON.stringify(body), now, taskId, expected);
      this.event(taskId, phase, patch, now); return this.get(taskId);
    });
  }
  requestFreshUnsubmittedRecheck(taskId,requestedAt,now=Date.now()) {
    const task=this.get(taskId);if(task?.phase!=='blocked'||!knownUnsubmitted(task)||!Number.isFinite(requestedAt)||requestedAt<=task.updatedAt||requestedAt>now)return false;
    return this.transaction(()=>{const current=this.get(taskId);requireThat(current.phase==='blocked'&&knownUnsubmitted(current),'RETRY_FORBIDDEN','任务提交边界已变化，先回读核实');
      const {id,shopId,phase,updatedAt,...body}=current;body.retryAfter=now;this.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(body),now,taskId);
      this.event(taskId,'fresh-unsubmitted-recheck-requested',{shopId,requestedAt,submitAttempts:0,riskAttempts:0},now);return true;});
  }
  beginSubmit(taskId, proof, now = Date.now()) {
    const task = this.get(taskId);
    if(task)assertOriginalRebuildConsent(this,task,now);
    if(task){this.assertPricePlans(task.shopId,task.plans);assertRecoveryCapacity(task.plans);}
    requireThat(task?.phase === 'prepared' && knownUnsubmitted(task) && proof?.taskId === taskId && proof.at > 0 && now - proof.at <= 30000,
      'SUBMIT_PROOF', '提交证明缺失、过期或已尝试提交');
    const verified=proveDraft(task,proof.observation,now);
    requireThat(verified.plansFingerprint===proof.plansFingerprint&&verified.materialFingerprint===proof.materialFingerprint,'SUBMIT_PROOF','草稿证明与计划不一致');
    return this.transition(taskId, 'prepared', 'submitting', { submitAttempts: 1, submittedAt: now, draftProof: verified }, now);
  }
  beginRiskConfirmation(taskId, proof, now = Date.now()) {
    return this.transaction(() => {
      const task = this.get(taskId);
      if(task)assertOriginalRebuildConsent(this,task,now);
      if(task)assertRecoveryCapacity(task.plans);
      requireThat(task && ['submitting', 'unknown', 'verifying'].includes(task.phase) && task.riskAttempts === 0 &&
        task.plans.every(p => p.originalRiskAllowed||p.approvedRiskAllowed&&p.priceApprovalId) && proof?.taskId === taskId && proof.kind==='original-discount-risk' &&
        proof.at>0 && proof.at<=now+5000 && now-proof.at<=30000 && proof.observation &&
        Array.isArray(proof.observation.dialogs) && proof.observation.dialogs.length===1 &&
        /低价|风险折扣/.test(proof.observation.dialogs[0]) && /仍要创建/.test(proof.observation.dialogs[0]),
        'RISK_PROOF', '低价提示未对应已授权原折扣，或已尝试确认');
      proveOriginalRisk(task,proof.observation,now);
      this.assertPricePlans(task.shopId,task.plans);
      const { id, shopId, phase, updatedAt, ...body } = task;
      Object.assign(body, { riskAttempts: 1, riskAttemptedAt: now, riskProof: proof });
      this.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(body), now, taskId);
      this.event(taskId, 'risk-confirmation-attempted', { proof }, now); return this.get(taskId);
    });
  }
  recoverInterrupted(shopId,now=Date.now()) {
    requireThat(Number.isSafeInteger(now)&&now>0,'RECOVERY_TIME','重启恢复时间无效');
    for (const task of this.list(shopId)) {
      if (['submitting', 'verifying'].includes(task.phase)) this.transition(task.id, task.phase, 'unknown', { reason: 'process-restarted-readback-only' },now);
      else if (['queued','prepared'].includes(task.phase)||task.phase==='blocked'&&task.reason===restartBlockReason&&task.retryAfter==null) {
        this.transaction(()=>{
          const current=this.get(task.id);
          requireThat(current&&fingerprint(current)===fingerprint(task),'JOURNAL_TRANSITION','重启核验期间任务已变化');
          const {id,shopId:storedShop,phase:previousPhase,updatedAt,...body}=current,safe=knownUnsubmitted(current);
          const phase=safe?'blocked':'unknown',patch=safe?{reason:restartBlockReason,retryAfter:now}:{reason:'restart-submit-boundary-unconfirmed-readback-only'};
          // Keep the old plan, exact approval identity and any contradictory
          // boundary fields. This only permits a fresh normal recheck; it does
          // not queue stale proof or manufacture a missing zero-attempt count.
          Object.assign(body,patch);
          this.db.prepare('UPDATE tasks SET phase=?,body=?,updated=? WHERE id=? AND phase=?').run(phase,JSON.stringify(body),now,id,previousPhase);
          this.event(id,phase,{...patch,previousPhase,restartRecheckRequired:safe},now);
        });
      }
    }
  }
  remember(baseline, now = Date.now()) {
    validateHistorical(baseline);
    const {observedAt,...stable}=baseline;
    this.db.prepare('INSERT OR IGNORE INTO baselines VALUES(?,?,?,?,?)').run(baseline.shopId, baseline.productId, fingerprint(stable), now, JSON.stringify(baseline));
  }
  histories(shopId) { return this.db.prepare('SELECT body FROM baselines WHERE shop=? ORDER BY at DESC').all(shopId).map(r => JSON.parse(r.body)); }
  priceReview(reviewId) {const r=this.db.prepare('SELECT body FROM price_reviews WHERE id=?').get(reviewId);return r?JSON.parse(r.body):null;}
  priceReviews(shopId) {return this.db.prepare('SELECT body FROM price_reviews WHERE shop=? ORDER BY updated DESC,rowid DESC').all(shopId).map(r=>JSON.parse(r.body));}
  priceReviewCounts(shopId,{hiddenProductIds=[],hideExpiredAt=null,hideUnconfirmed=false,scope=null,allowedReviewIds=null}={}) {
    const expiry=priceViewExpiry(hideExpiredAt);
    if(scope==='pending')expiry.sql+=" AND state='pending'";
    else if(scope==='history')expiry.sql+=" AND state IN ('approved','declined')";
    else if(hideUnconfirmed)expiry.sql+=" AND state NOT IN ('pending','declined')";
    if(scope==='pending'&&Array.isArray(allowedReviewIds)){expiry.sql+=' AND id IN (SELECT value FROM json_each(?))';expiry.params.push(JSON.stringify(allowedReviewIds));}
    const row=this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(state='pending'),0) AS pending FROM price_reviews WHERE shop=? AND product NOT IN (SELECT value FROM json_each(?))${expiry.sql}`).get(shopId,JSON.stringify(hiddenProductIds),...expiry.params);
    return {total:row.total,pending:row.pending};
  }
  priceRecheckProgress(shopId,options={}) {
    return buildRecheckProgress({shopId,...(shopId?{queue:recoveryRequests(this,shopId),reviews:this.priceReviews(shopId),checks:this.productChecks(shopId),tasks:this.list(shopId)}:{}),...options});
  }
  priceReviewPage(shopId,{page=0,pageSize=10,direction='all',recheckPage=0,hiddenProductIds=[],products=[],hideExpiredAt=null,hideUnconfirmed=false,scope=null,allowedReviewIds=null}={}) {
    const bounded=(value,fallback)=>Number.isSafeInteger(Number(value))?Number(value):fallback;
    const size=Math.min(20,Math.max(1,bounded(pageSize,10))),counts=this.priceReviewCounts(shopId,{hiddenProductIds,hideExpiredAt,hideUnconfirmed,scope,allowedReviewIds}),expiry=priceViewExpiry(hideExpiredAt);
    if(scope==='pending')expiry.sql+=" AND state='pending'";
    else if(scope==='history')expiry.sql+=" AND state IN ('approved','declined')";
    else if(hideUnconfirmed)expiry.sql+=" AND state NOT IN ('pending','declined')";
    if(scope==='pending'&&Array.isArray(allowedReviewIds)){expiry.sql+=' AND id IN (SELECT value FROM json_each(?))';expiry.params.push(JSON.stringify(allowedReviewIds));}
    const visibility=' AND product NOT IN (SELECT value FROM json_each(?))',hidden=JSON.stringify(hiddenProductIds);
    const mode=['increase','decrease'].includes(direction)?direction:'all';
    const lower="EXISTS (SELECT 1 FROM json_each(price_reviews.body,'$.rows') AS sku WHERE json_extract(sku.value,'$.saleFen') < json_extract(sku.value,'$.previousFen'))";
    const scopeState=scope?'':" AND state='pending'";
    const decrease=this.db.prepare(`SELECT COUNT(*) AS n FROM price_reviews WHERE shop=?${visibility}${expiry.sql}${scopeState} AND ${lower}`).get(shopId,hidden,...expiry.params).n;
    const directionCounts={increase:(scope?counts.total:counts.pending)-decrease,decrease};
    const total=mode==='all'?counts.total:directionCounts[mode];
    const condition=mode==='all'?'':`${scopeState} AND ${mode==='increase'?'NOT ':''}${lower}`;
    const pages=Math.max(1,Math.ceil(total/size)),current=Math.min(pages-1,Math.max(0,bounded(page,0)));
    const reviewTasks=this.list(shopId);
    const reviews=this.db.prepare(`SELECT body FROM price_reviews WHERE shop=?${visibility}${expiry.sql}${condition} ORDER BY (state='pending') DESC,updated DESC,rowid DESC LIMIT ? OFFSET ?`)
      .all(shopId,hidden,...expiry.params,size,current*size).map(r=>{
        const review=JSON.parse(r.body);if(review.status!=='pending')return {...review,requiresReconfirmation:needsPriceReconfirmation(review)};
        const attempts=reviewTasks.filter(task=>task.plans.some(p=>p.productId===review.productId));
        const activityChecks=['限量抢购','限时抢购'].flatMap(type=>{
          const task=attempts.find(t=>t.plans.some(p=>p.productId===review.productId&&p.type===type));
          return task?[{type,at:task.updatedAt,reason:task.phase==='verified'?'该次创建已独立回读，不代表当前仍有效':task.reason||'该次任务仍在处理'}]:[];
        });
        return{...review,options:priceOptions(review),activityChecks};
      });
    return {shopId,...counts,total,scope,direction:mode,directionCounts,page:current,pageSize:size,pages,reviews,rechecks:this.priceRecheckProgress(shopId,{page:recheckPage,pageSize:size,hiddenProductIds,products,hideExpiredAt,hideUnconfirmed})};
  }
  priceTargets(shopId){return this.db.prepare('SELECT r.body FROM price_targets t JOIN price_reviews r ON r.id=t.review WHERE t.shop=?').all(shopId).map(r=>JSON.parse(r.body));}
  priceTarget(shopId,productId) {const r=this.db.prepare('SELECT review FROM price_targets WHERE shop=? AND product=?').get(shopId,productId);return r?this.priceReview(r.review):null;}
  supersedePriceReviews(shopId,productId,reason,now=Date.now()) {
    return this.transaction(()=>{
      const rows=this.db.prepare("SELECT id,body FROM price_reviews WHERE shop=? AND product=? AND state='pending'").all(shopId,productId);
      for(const row of rows){const review={...JSON.parse(row.body),status:'superseded',supersededAt:now,supersededReason:reason};
        this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(review.status,JSON.stringify(review),now,row.id);
      }
      return rows.length;
    });
  }
  recordPriceReview(review,now=Date.now(),{refreshPending=false}={}) {
    const task=this.get(review.taskId);
    requireThat(task&&task.shopId===review.shopId&&['queued','prepared'].includes(task.phase)&&task.submitAttempts===0&&review.source==='live-platform-draft',
      'PRICE_REVIEW_EVIDENCE','只有本次未提交草稿的直接读取能生成调价建议');
    const care=activeCareRecoveryGrant(this,review.shopId,now),nonReducing=review.rows.every(row=>row.saleFen>=row.previousFen)&&review.rows.some(row=>row.saleFen>row.previousFen);
    return this.savePriceReview(review,now,{refreshPending:refreshPending||!!care&&nonReducing,refreshDeclinedBefore:care&&nonReducing?care.at:0});
  }
  recordRemovalPriceReview(plan,loss,now=Date.now()){
    const history=this.histories(plan.shopId).find(b=>fingerprint(b)===plan.historicalFingerprint);
    requireThat(history?.shopId===plan.shopId&&history.productId===plan.productId&&plan.skus.every(s=>{
      const original=history.skus.find(r=>r.id===s.id);
      return original&&original.baseFen===s.baseFen&&normalizeName(original.name)===s.name&&
       original.discount===(s.originalDiscount??s.discount)&&
       (plan.priceApprovalId||s.discount===original.discount);
    }),'PRICE_REVIEW_CHANGED','倍率建议的原价、历史折扣或规格已变化');
    requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),
      'PENDING','商品已有未完成或结果未知的任务，只能先核实');
    this.assertPricePlans(plan.shopId,[plan]);
    const proposal=makeRemovalPriceReview(plan,loss,now),care=activeCareRecoveryGrant(this,plan.shopId,now),nonReducing=proposal.rows.every(row=>row.saleFen>=row.previousFen)&&proposal.rows.some(row=>row.saleFen>row.previousFen);
    return this.savePriceReview(proposal,now,{refreshPending:!!care&&nonReducing,refreshDeclinedBefore:care&&nonReducing?care.at:0});
  }
  recordPriceReconfirmation(plan,now=Date.now()){
    requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),
      'PENDING','此商品有未完成或结果未知的提交，先独立核实');
    const history=this.histories(plan.shopId).find(b=>fingerprint(b)===plan.historicalFingerprint);
    requireThat(history&&history.productId===plan.productId&&plan.skus.every(s=>history.skus.some(h=>h.id===s.id&&h.baseFen===s.baseFen&&normalizeName(h.name)===s.name&&h.discount===s.discount)),
      'PRICE_APPROVAL_CHANGED','重新确认价格需要匹配的原始规格历史');
    return this.savePriceReview(makePriceReconfirmation(plan,this.priceTarget(plan.shopId,plan.productId),now),now);
  }
  recordHistoryReconfirmation(plan,now=Date.now()){
    requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),
      'PENDING','此商品仍有未完成或未知提交，先回读核实');
    const history=this.histories(plan.shopId).find(b=>fingerprint(b)===plan.historicalFingerprint);
    requireThat(history&&history.productId===plan.productId&&plan.skus.every(s=>history.skus.some(h=>h.id===s.id&&h.baseFen===s.baseFen&&normalizeName(h.name)===s.name&&h.discount===s.discount)),
      'PRICE_SOURCE_CHANGED','新确认必须来自完整保存的原始规格历史');
    return this.savePriceReview(makeHistoryReconfirmation(plan,this.priceTarget(plan.shopId,plan.productId),now),now);
  }
  recordRebuildPriceReview(plan,detail,now=Date.now()){
    const baseline=this.histories(plan.shopId).find(b=>fingerprint(b)===plan.historicalFingerprint);
    requireThat(baseline&&baseline.productId===plan.productId,'REBUILD_REVIEW_EVIDENCE','重新创建的历史来源已变化');
    requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),
      'PENDING','此商品已有未完成或未知提交，先回读核实');
    this.assertPricePlans(plan.shopId,[plan]);return this.savePriceReview(makeRebuildReview(plan,detail,now),now);
  }
  savePriceReview(review,now,{refreshPending=false,refreshDeclinedBefore=0}={}){
    const prior=this.db.prepare('SELECT body FROM price_reviews WHERE shop=? AND product=? ORDER BY updated DESC,rowid DESC').all(review.shopId,review.productId).map(r=>JSON.parse(r.body)).find(r=>r.key===review.key);
    const oldDecline=prior?.status==='declined'&&refreshDeclinedBefore>0&&this.db.prepare('SELECT updated FROM price_reviews WHERE id=?').get(prior.id)?.updated<refreshDeclinedBefore;
    if(prior&&(prior.status==='approved'||prior.status==='declined'&&!oldDecline||prior.status==='pending'&&prior.expiresAt>now&&!refreshPending))return prior;
    this.supersedePriceReviews(review.shopId,review.productId,'新的平台价格要求已读取',now);
    const saved={...structuredClone(review),id:randomUUID(),status:'pending'};
    this.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(saved.id,saved.shopId,saved.productId,saved.status,JSON.stringify(saved),now);
    this.event(saved.taskId,'price-review-pending',{shopId:saved.shopId,productId:saved.productId,reviewId:saved.id},now);return saved;
  }
  decidePriceReview(shopId,reviewId,key,decision,{confirmedSkuIds=[],acceptPriceAndRisk=false,historicalFingerprint=null,optionId=null,optionKey=null,confirmRebuild=false,queueRecovery=false,approvalContext=null,manualDiscounts=null,manualActivityType=null}={},now=Date.now()) {
    return this.transaction(()=>{
      const r=this.priceReview(reviewId);
      requireThat(r&&r.shopId===shopId&&r.key===key,'PRICE_REVIEW_CHANGED','店铺或调价建议已变化');
      requireThat(['approve','decline','recalculate'].includes(decision),'PRICE_REVIEW_DECISION','调价确认操作无效');
      requireThat(!this.list(shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===r.productId)),
        'PENDING','此商品仍有未完成或结果未知的提交，先独立核实');
      if(decision==='recalculate'&&needsPriceReconfirmation(r)){
        requireThat(this.priceTarget(shopId,r.productId)?.id===r.id,'PRICE_REVIEW_CHANGED','当前守护目标已经变化');
        this.clearProductCheck(shopId,r.productId);
        this.event(null,'price-reconfirmation-requested',{shopId,productId:r.productId,reviewId:r.id},now);
        if(queueRecovery)requestRecovery(this,shopId,[{productId:r.productId,approvalId:r.id}],'price-recalculation-requested',now,{transaction:false});
        return r; // Never rewrite or revoke the immutable approved record.
      }
      if(decision==='approve'){
        requireThat(r.kind!=='limited-rebuild'||confirmRebuild===true,'REBUILD_CONSENT_REQUIRED','须明确确认重新创建活动、准确时长及重新提供的限量额度');
        requireThat(!r.originalUnavailable||optionId!==null&&optionKey!==null,'PRICE_OPTION_CHANGED','当前活动没有可直接确认的价格方案，请选择可用方案并核对全部规格');
        requireThat(acceptPriceAndRisk===true&&Array.isArray(confirmedSkuIds)&&new Set(confirmedSkuIds).size===confirmedSkuIds.length&&
          fingerprint([...confirmedSkuIds].sort())===fingerprint(r.rows.map(row=>row.id).sort()),'PRICE_CONSENT_REQUIRED','须核对全部规格并明确确认表内价格');
        requireThat(r.status==='pending'&&r.expiresAt>now&&r.createdAt<=now,'PRICE_REVIEW_EXPIRED','建议已处理或过期，请重新核对');
        requireThat(r.historicalFingerprint===historicalFingerprint,'PRICE_REVIEW_CHANGED','历史来源已变化，请重新核对');
        const target=this.priceTarget(shopId,r.productId),previous=r.kind==='history-reconfirmation'?target?.id||null:target?.historicalFingerprint===r.historicalFingerprint?target.id:null;
        requireThat((r.previousApprovalId||null)===previous,'PRICE_REVIEW_CHANGED','此前已确认的价格已变化');
        if(optionId!==null||optionKey!==null){
          const priceContext={reviews:this.priceReviews(shopId),tasks:this.list(shopId),now};
          const option=optionId==='manual-discount'&&approvalContext==='recovery-blockers'?manualPriceOption(activityPriceBasis(r,manualActivityType||r.type,priceContext),manualDiscounts,now):(approvalContext==='recovery-blockers'?blockerPriceOptions(r,priceContext):priceOptions(r)).find(o=>o.id===optionId);
          requireThat(option?.available&&option.key===optionKey,'PRICE_OPTION_CHANGED','所选方案不可用或已经变化，请重新核对');
          r.originalProposalRows=structuredClone(r.rows);
          r.rows=structuredClone(option.rows);
          if(option.ratio)r.ratio=structuredClone(option.ratio);
          if(option.campaignTarget){
            r.campaignTarget=structuredClone(option.campaignTarget);
            r.type=option.campaignTarget.type;r.rules=structuredClone(option.campaignTarget.rules);
            if(!option.ratio)delete r.ratio;
          }
          if(option.rebuildTarget)r.rebuildTarget=structuredClone(option.rebuildTarget);
          r.selectedOption={id:option.id,key:option.key,label:option.label,...(option.evidenceReviewId?{evidenceReviewId:option.evidenceReviewId}:{}),activityType:option.activityType};
        }
        if(r.kind==='history-reconfirmation')assertHistoryReconfirmation(r,target,this.histories(shopId).find(b=>fingerprint(b)===r.historicalFingerprint));
        else if(r.kind==='rounding-reconfirmation')assertPriceReconfirmation(r,target);
        else requireThat(r.rows.every(row=>row.saleFen===saleFen(row.baseFen,row.discount)&&
          row.previousFen===saleFen(row.baseFen,row.previousDiscount)),
          'PRICE_REVIEW_CHANGED','价格取整规则已更新，请重新计算并核对全部规格价格');
        r.status='approved';r.approvedAt=now;if(approvalContext==='recovery-blockers')r.approvalContext=approvalContext;r.consent={exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true,
          ...(r.kind==='limited-rebuild'?{rebuildConfirmed:true,activityFingerprint:fingerprint(r.rebuildTarget),sourceFingerprint:fingerprint(r.rebuildSource)}:{})};
        this.db.prepare('INSERT INTO price_targets VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET review=excluded.review').run(shopId,r.productId,r.id);
      }else{
        requireThat(['pending','declined'].includes(r.status),'PRICE_REVIEW_CHANGED','这份建议不能再修改');
        r.status=decision==='decline'?'declined':'superseded';
        if(decision==='recalculate'){
          const task=this.get(r.taskId);
          if(task?.phase==='blocked'&&task.submitAttempts===0){
            const {id,shopId:taskShop,phase,updatedAt,...body}=task;body.retryAfter=now;
            this.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(body),now,id);
          }
        }
      }
      this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(r.status,JSON.stringify(r),now,r.id);
      this.clearProductCheck(shopId,r.productId);
      this.event(null,'price-review-'+r.status,{shopId,productId:r.productId,reviewId:r.id},now);
      if(queueRecovery&&['approve','recalculate'].includes(decision))requestRecovery(this,shopId,[{productId:r.productId,approvalId:r.id}],decision==='approve'?'exact-price-approved':'price-recalculation-requested',now,{transaction:false});
      return r;
    });
  }
  approveOriginalPriceContinuity(plan,now=Date.now()) {
    requireThat(activeOriginalPriceRecoveryGrant(this,plan.shopId,now),'ORIGINAL_PRICE_CONSENT_REQUIRED','本店未开启原价自动恢复');
    const proposal=this.recordHistoryReconfirmation(plan,now);
    return this.transaction(()=>{
      const grant=activeOriginalPriceRecoveryGrant(this,plan.shopId,now),r=this.priceReview(proposal.id),previous=this.priceTarget(plan.shopId,plan.productId);
      requireThat(grant&&r?.status==='pending'&&r.expiresAt>now&&now-r.createdAt<=30000,'ORIGINAL_PRICE_BLOCKED','旧价格或本店原价规则已变化，已转入恢复受阻');
      requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),'PENDING','已有未知提交，只回读不重复创建');
      assertHistoryReconfirmation(r,previous,this.histories(plan.shopId).find(b=>fingerprint(b)===plan.historicalFingerprint));
      requireThat(previous.rows.length===r.rows.length,'ORIGINAL_PRICE_BLOCKED','规格集合发生变化，不能自动沿用旧价格');
      r.status='approved';r.approvedAt=now;r.approvalKind='original-price-continuity';
      r.continuityConsent={grantId:grant.id,targetsFingerprint:fingerprint(r.rows),continueGuardingExactPrices:true};
      requireThat(validOriginalPriceApproval(this,r),'ORIGINAL_PRICE_BLOCKED','原价格、活动规则或旧批准无法完整核实');
      this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(r.status,JSON.stringify(r),now,r.id);
      this.db.prepare('INSERT INTO price_targets VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET review=excluded.review').run(plan.shopId,plan.productId,r.id);
      this.event(null,'original-price-continuity-approved',{shopId:plan.shopId,productId:plan.productId,reviewId:r.id,previousApprovalId:previous.id,grantId:grant.id},now);return r;
    });
  }
  approveCarePriceReview(shopId,reviewId,key,historicalFingerprint,now=Date.now()) {
    return this.transaction(()=>{
      const grant=activeCareRecoveryGrant(this,shopId,now),r=this.priceReview(reviewId);
      requireThat(grant,'CARE_CONSENT_REQUIRED','本店尚未授权省心守护');
      requireThat(r?.shopId===shopId&&r.key===key&&r.historicalFingerprint===historicalFingerprint,'PRICE_REVIEW_CHANGED','店铺、历史或价格方案已变化');
      requireThat(!this.list(shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===r.productId)),'PENDING','已有未完成或未知提交，只回读不重复创建');
      const baseline=this.histories(shopId).find(b=>fingerprint(b)===historicalFingerprint),previous=this.priceTarget(shopId,r.productId);
      requireThat(baseline&&r.rows.length===baseline.skus.length&&r.rows.every(row=>baseline.skus.some(s=>s.id===row.id&&normalizeName(s.name)===row.name&&s.baseFen===row.baseFen&&s.discount===row.historicalDiscount)),'PRICE_REVIEW_CHANGED','全部规格、原价或历史折扣无法完整对应');
      requireThat((r.previousApprovalId||null)===(previous?.historicalFingerprint===r.historicalFingerprint?previous.id:null),'PRICE_REVIEW_CHANGED','此前守护目标已变化');
      const evidence=careSourceEvidence(this,r),candidate=carePriceCandidate(r,evidence,now),source=structuredClone(r);
      r.rows=structuredClone(candidate.rows);if(candidate.ratio)r.ratio=structuredClone(candidate.ratio);
      r.status='approved';r.approvedAt=now;r.approvalKind='automatic-price-increase';r.careSource=source;r.careEvidence=evidence;
      r.selectedOption={id:'care-balanced',key:candidate.key,label:'省心守护：本类型不降价方案',activityType:r.type};
      r.automaticConsent={careGrantId:grant.id,targetsFingerprint:fingerprint(r.rows),sourceFingerprint:fingerprint(source),evidenceFingerprint:fingerprint(evidence),continueGuardingExactPrices:true};
      requireThat(validCarePriceApproval(this,r),'CARE_APPROVAL_CHANGED','省心守护确切价格或来源校验失败');
      this.db.prepare('INSERT INTO price_targets VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET review=excluded.review').run(shopId,r.productId,r.id);
      this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(r.status,JSON.stringify(r),now,r.id);
      this.clearProductCheck(shopId,r.productId);this.event(null,'care-price-approved',{shopId,productId:r.productId,reviewId:r.id,grantId:grant.id},now);return r;
    });
  }
  approveCareRounding(plan,now=Date.now()) {
    const proposal=this.recordPriceReconfirmation(plan,now);
    return this.transaction(()=>{
      const grant=activeCareRecoveryGrant(this,plan.shopId,now),r=this.priceReview(proposal.id),previous=this.priceTarget(plan.shopId,plan.productId);
      requireThat(grant&&r?.status==='pending'&&r.createdAt<=now&&now-r.createdAt<=30000&&r.expiresAt>now,'CARE_CONSENT_REQUIRED','本店省心规则或新金额依据已变化');
      requireThat(!this.list(plan.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===plan.productId)),'PENDING','已有未知提交，先独立回读');
      assertPriceReconfirmation(r,previous);
      requireThat((previous.consent?.exactPrices&&previous.consent?.matchedRiskConfirmation||validAutomaticPriceApproval(this,previous)||validOriginalPriceApproval(this,previous))&&r.rows.length===previous.rows.length&&!r.skippedSkuIds.length&&r.rows.every(row=>row.saleFen>=row.previousFen)&&r.type===previous.type&&fingerprint(r.rules)===fingerprint(previous.rules),'CARE_REVIEW_REQUIRED','金额更新涉及降价、规格或活动规则变化，仍须人工确认');
      const source=structuredClone(r);r.status='approved';r.approvedAt=now;r.approvalKind='automatic-price-increase';r.careSource=source;
      r.automaticConsent={careGrantId:grant.id,careKind:'rounding-reconfirmation',targetsFingerprint:fingerprint(r.rows),sourceFingerprint:fingerprint(source),continueGuardingExactPrices:true};
      requireThat(validCarePriceApproval(this,r),'CARE_APPROVAL_CHANGED','金额更新的确切价格或原确认不能核实');
      this.db.prepare('INSERT INTO price_targets VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET review=excluded.review').run(plan.shopId,plan.productId,r.id);
      this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(r.status,JSON.stringify(r),now,r.id);
      this.clearProductCheck(plan.shopId,plan.productId);this.event(null,'care-rounding-approved',{shopId:plan.shopId,productId:plan.productId,reviewId:r.id,grantId:grant.id},now);return r;
    });
  }
  approvePriceIncrease(shopId,reviewId,key,historicalFingerprint,now=Date.now()) {
    return this.transaction(()=>{
      const grant=activePriceIncreaseGrant(this,shopId,now),r=this.priceReview(reviewId);
      requireThat(!activeOriginalPriceRecoveryGrant(this,shopId,now),'ORIGINAL_PRICE_BLOCKED','本店只允许原价恢复，不能自动提价');
      requireThat(grant,'PRICE_INCREASE_CONSENT_REQUIRED','本店尚未授权自动提价');
      requireThat(r?.shopId===shopId&&r.key===key&&r.historicalFingerprint===historicalFingerprint,'PRICE_REVIEW_CHANGED','店铺、价格建议或历史来源已变化');
      requireThat(r.status==='pending'&&r.source==='live-platform-draft'&&r.createdAt>0&&r.createdAt<=now&&now-r.createdAt<=30000&&r.expiresAt>now,
        'PRICE_REVIEW_EXPIRED','自动提价需要本次新鲜草稿中的明确限制');
      const sourceTask=this.get(r.taskId),sourcePlan=sourceTask?.plans.find(p=>p.productId===r.productId);
      requireThat(sourceTask?.phase==='blocked'&&sourceTask.submitAttempts===0&&sourcePlan?.skus.length===r.rows.length&&r.rows.every(row=>{
        const sku=sourcePlan.skus.find(s=>s.id===row.id);return sku&&sku.name===row.name&&sku.baseFen===row.baseFen&&sku.discount===row.previousDiscount&&sku.saleFen===row.previousFen&&
          (sku.originalDiscount??sku.discount)===row.historicalDiscount;
      }),'PRICE_REVIEW_CHANGED','原草稿中的已有价格或规格集合已变化');
      requireThat(!this.list(shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===r.productId)),'PENDING','先核实此商品已有的任务');
      const previous=this.priceTarget(shopId,r.productId);
      requireThat((r.previousApprovalId||null)===(previous?.historicalFingerprint===r.historicalFingerprint?previous.id:null),'PRICE_REVIEW_CHANGED','此前守护价格已变化');
      requireThat(isAutomaticPriceIncrease(r),'PRICE_INCREASE_REVIEW_REQUIRED','存在降价、未识别限制或并非最近合法的提价档位，需要逐规格确认');
      r.status='approved';r.approvedAt=now;r.approvalKind='automatic-price-increase';
      r.automaticConsent={grantId:grant.id,targetsFingerprint:fingerprint(r.rows),continueGuardingExactPrices:true};
      this.db.prepare('INSERT INTO price_targets VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET review=excluded.review').run(shopId,r.productId,r.id);
      this.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run(r.status,JSON.stringify(r),now,r.id);
      this.clearProductCheck(shopId,r.productId);this.event(null,'price-increase-policy-approved',{shopId,productId:r.productId,reviewId:r.id,grantId:grant.id},now);return r;
    });
  }
  assertPricePlans(shopId,plans) {
    assertCampaignPolicy(this,shopId,plans);
    for(const plan of plans){
      if(!plan.priceApprovalId){requireThat(!plan.approvedRiskAllowed,'PRICE_APPROVAL_MISSING','缺少明确的逐规格确认');continue;}
      const review=this.priceReview(plan.priceApprovalId),baseline=this.histories(shopId).find(b=>fingerprint(b)===plan.historicalFingerprint);
      if(review?.kind==='limited-rebuild')requireThat(review.consent?.rebuildConfirmed===true&&fingerprint(rebuildMaterial(plan))===fingerprint(review.rebuildTarget),
        'REBUILD_CONSENT_REQUIRED','重新创建的活动类型、时长或限量与明确确认不一致');
      requireThat(review?.status==='approved'&&(review.consent?.exactPrices&&review.consent?.matchedRiskConfirmation||validAutomaticPriceApproval(this,review)||validOriginalPriceApproval(this,review))&&baseline&&this.priceTarget(shopId,plan.productId)?.id===review.id&&
        review.shopId===shopId&&plan.shopId===shopId&&review.productId===plan.productId&&review.key===plan.priceApprovalKey&&review.historicalFingerprint===plan.historicalFingerprint,
        'PRICE_APPROVAL_CHANGED','调价确认与当前执行计划不一致');
      for(const sku of plan.skus){const original=baseline.skus.find(s=>s.id===sku.id),approved=review.rows.find(r=>r.id===sku.id);
        requireThat(original&&(approved||review.kind!=='rounding-reconfirmation')&&original.baseFen===sku.baseFen&&normalizeName(original.name)===sku.name&&
          sku.discount===(approved?.discount??original.discount)&&sku.saleFen===saleFen(sku.baseFen,sku.discount)&&
          (!approved||sku.saleFen===approved.saleFen),
          'PRICE_APPROVAL_CHANGED','执行价格超出逐规格确认范围');
      }
    }
  }
  productChecks(shopId){return this.db.prepare('SELECT body FROM product_checks WHERE shop=?').all(shopId).map(r=>JSON.parse(r.body));}
  putProductCheck(shopId,productId,check){
    const stored=this.db.prepare('SELECT body FROM product_checks WHERE shop=? AND product=?').get(shopId,productId),previous=stored?JSON.parse(stored.body):null;
    const body={shopId,productId,...check,...(this.diagnosticContext?{runtimeBuild:this.diagnosticContext}:{})};delete body.lastKnownInactive;
    const now=Date.now(),retained=lastInactiveProductEvidence({shopId,productId,check:previous,now}),current=lastInactiveProductEvidence({shopId,productId,check:body,now}),onShelf=explicitOnShelfState({shopId,productId,check:body,now});
    if(body.shopId===shopId&&body.productId===productId&&retained&&(!onShelf||onShelf.observedAt<retained.productState.observedAt)&&(!current||current.productState.observedAt<retained.productState.observedAt))body.lastKnownInactive={code:retained.code,productState:structuredClone(retained.productState),...(retained.at!=null?{at:retained.at}:{})};
    this.db.prepare('INSERT INTO product_checks VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET body=excluded.body').run(shopId,productId,JSON.stringify(body));
  }
  clearInactiveDisplayAfterPrecheck(shopId,productId,current,now=Date.now()){
    if(current?.shopId!==shopId||current.productId!==productId||current.complete!==true||current.offShelf!==false||!Number.isFinite(current.observedAt)||current.observedAt<=0||current.observedAt>now||now-current.observedAt>30000||!Array.isArray(current.skus)||!current.skus.length)return false;
    // Native create forms do not expose SKU IDs. Match their actual complete
    // precheck contract; the following planner still validates historical IDs.
    if(current.skus.some(s=>!s||typeof s.name!=='string'||!normalizeName(s.name)||!Number.isSafeInteger(s.baseFen)||s.baseFen<=0||(s.id==null?s.idSource!=='unavailable-in-create-form':typeof s.id!=='string'||!/^\d{3,25}$/.test(s.id)))||new Set(current.skus.map(s=>normalizeName(s.name))).size!==current.skus.length)return false;
    const knownIds=current.skus.filter(s=>s.id!=null).map(s=>s.id);if(new Set(knownIds).size!==knownIds.length)return false;
    const row=this.db.prepare('SELECT body FROM product_checks WHERE shop=? AND product=?').get(shopId,productId);if(!row)return false;
    const check=JSON.parse(row.body),evidence=lastInactiveProductEvidence({shopId,productId,check,now});if(!evidence||current.observedAt<evidence.productState.observedAt)return false;
    if(['OFF_SHELF','PRODUCT_RECYCLED'].includes(check.code))this.clearProductCheck(shopId,productId);
    else{delete check.lastKnownInactive;this.db.prepare('UPDATE product_checks SET body=? WHERE shop=? AND product=?').run(JSON.stringify(check),shopId,productId);}
    this.event(null,'inactive-display-cleared-by-precheck',{shopId,productId,observedAt:current.observedAt,skuCount:current.skus.length,source:'complete-product-precheck; display-only'},now);return true;
  }
  clearProductCheck(shopId,productId){this.db.prepare('DELETE FROM product_checks WHERE shop=? AND product=?').run(shopId,productId);}
  putSettings(shopId, settings) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(shop) DO UPDATE SET body=excluded.body').run(shopId, JSON.stringify(settings)); }
  settings(shopId) { const row = this.db.prepare('SELECT body FROM settings WHERE shop=?').get(shopId); return row ? JSON.parse(row.body) : null; }
  events(limit=100){return this.db.prepare('SELECT task,at,kind,body FROM events ORDER BY seq DESC LIMIT ?').all(limit).map(r=>({...r,detail:JSON.parse(r.body),body:undefined}));}
  lease(shopId, owner, now = Date.now(), ttl = 60000) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM leases WHERE shop=?').get(shopId);
      requireThat(!row || row.owner === owner || row.expires < now, 'BUSY', '同店已有后台实例持有执行权');
      this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(shop) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(shopId, owner, now + ttl);
    });
  }
  release(shopId, owner) { this.db.prepare('DELETE FROM leases WHERE shop=? AND owner=?').run(shopId, owner); }
  assertLease(shopId,owner,now=Date.now()){
    const row=this.db.prepare('SELECT owner,expires FROM leases WHERE shop=?').get(shopId);
    requireThat(row?.owner===owner&&row.expires>now,'LEASE_LOST','本进程已失去店铺执行权');
  }
  close() { this.db.close(); }
}
