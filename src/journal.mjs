import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint, requireThat, validateHistorical, proveDraft, proveOriginalRisk } from './policy.mjs';

const transitions = {
  queued: ['prepared', 'blocked'], prepared: ['submitting', 'blocked'],
  submitting: ['verifying', 'unknown'], unknown: ['verifying', 'verified', 'blocked'],
  verifying: ['verified', 'unknown', 'blocked'], blocked: ['queued'], verified: []
};
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
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(task, kind, detail, now = Date.now()) {
    this.db.prepare('INSERT INTO events(task,at,kind,body) VALUES(?,?,?,?)').run(task, now, kind, JSON.stringify(detail));
  }
  get(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    return row ? { id: row.id, shopId: row.shop, phase: row.phase, updatedAt: row.updated, ...JSON.parse(row.body) } : null;
  }
  list(shopId) { return this.db.prepare('SELECT id FROM tasks WHERE shop=? ORDER BY updated DESC').all(shopId).map(row => this.get(row.id)); }
  enqueue(shopId, plans, lossEvidence, now = Date.now()) {
    requireThat(plans.length && plans.every(p => p.shopId === shopId), 'SHOP_MISMATCH', '任务不能跨店');
    requireThat(lossEvidence?.complete === true && lossEvidence.observedAt > 0 && now-lossEvidence.observedAt<=120000 && lossEvidence.observedAt<=now+5000 &&
      typeof lossEvidence.lossKey==='string' && lossEvidence.lossKey.length>0, 'LOSS_UNPROVEN', '缺少当前活动失效证明');
    const dedupe = fingerprint({ shopId, plans: plans.map(p => [p.productId, p.historicalFingerprint, p.skus]), loss: lossEvidence.lossKey });
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id FROM tasks WHERE dedupe=?').get(dedupe);
      if (prior) return this.get(prior.id);
      const pending = this.list(shopId).filter(t => !['verified', 'blocked'].includes(t.phase));
      requireThat(!pending.some(t => t.plans.some(p => plans.some(q => q.productId === p.productId))), 'PENDING', '商品已有未完成任务');
      const taskId = randomUUID(), title = '守护2-' + taskId.replaceAll('-', '').slice(0, 18);
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
      if(expected==='blocked')requireThat(task.submitAttempts===0&&task.retryAfter>0&&task.retryAfter<=now,'RETRY_FORBIDDEN','只能重试已明确未提交且已到重试时间的任务');
      const { id, shopId, phase: oldPhase, updatedAt, ...body } = task;
      Object.assign(body, patch);
      this.db.prepare('UPDATE tasks SET phase=?,body=?,updated=? WHERE id=? AND phase=?').run(phase, JSON.stringify(body), now, taskId, expected);
      this.event(taskId, phase, patch, now); return this.get(taskId);
    });
  }
  beginSubmit(taskId, proof, now = Date.now()) {
    const task = this.get(taskId);
    requireThat(task?.phase === 'prepared' && task.submitAttempts === 0 && proof?.taskId === taskId && proof.at > 0 && now - proof.at <= 30000,
      'SUBMIT_PROOF', '提交证明缺失、过期或已尝试提交');
    const verified=proveDraft(task,proof.observation,now);
    requireThat(verified.plansFingerprint===proof.plansFingerprint&&verified.materialFingerprint===proof.materialFingerprint,'SUBMIT_PROOF','草稿证明与计划不一致');
    return this.transition(taskId, 'prepared', 'submitting', { submitAttempts: 1, submittedAt: now, draftProof: verified }, now);
  }
  beginRiskConfirmation(taskId, proof, now = Date.now()) {
    return this.transaction(() => {
      const task = this.get(taskId);
      requireThat(task && ['submitting', 'unknown', 'verifying'].includes(task.phase) && task.riskAttempts === 0 &&
        task.plans.every(p => p.originalRiskAllowed) && proof?.taskId === taskId && proof.kind==='original-discount-risk' &&
        proof.at>0 && proof.at<=now+5000 && now-proof.at<=30000 && proof.observation &&
        Array.isArray(proof.observation.dialogs) && proof.observation.dialogs.length===1 &&
        /低价|风险折扣/.test(proof.observation.dialogs[0]) && /仍要创建/.test(proof.observation.dialogs[0]),
        'RISK_PROOF', '低价提示未对应已授权原折扣，或已尝试确认');
      proveOriginalRisk(task,proof.observation,now);
      const { id, shopId, phase, updatedAt, ...body } = task;
      Object.assign(body, { riskAttempts: 1, riskAttemptedAt: now, riskProof: proof });
      this.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(body), now, taskId);
      this.event(taskId, 'risk-confirmation-attempted', { proof }, now); return this.get(taskId);
    });
  }
  recoverInterrupted(shopId) {
    for (const task of this.list(shopId)) {
      if (['submitting', 'verifying'].includes(task.phase)) this.transition(task.id, task.phase, 'unknown', { reason: 'process-restarted-readback-only' });
      else if (['queued', 'prepared'].includes(task.phase)) this.transition(task.id, task.phase, 'blocked', { reason: 'pre-submit-proof-expired-on-restart' });
    }
  }
  remember(baseline, now = Date.now()) {
    validateHistorical(baseline);
    const {observedAt,...stable}=baseline;
    this.db.prepare('INSERT OR IGNORE INTO baselines VALUES(?,?,?,?,?)').run(baseline.shopId, baseline.productId, fingerprint(stable), now, JSON.stringify(baseline));
  }
  histories(shopId) { return this.db.prepare('SELECT body FROM baselines WHERE shop=? ORDER BY at DESC').all(shopId).map(r => JSON.parse(r.body)); }
  productChecks(shopId){return this.db.prepare('SELECT body FROM product_checks WHERE shop=?').all(shopId).map(r=>JSON.parse(r.body));}
  putProductCheck(shopId,productId,check){this.db.prepare('INSERT INTO product_checks VALUES(?,?,?) ON CONFLICT(shop,product) DO UPDATE SET body=excluded.body').run(shopId,productId,JSON.stringify({shopId,productId,...check}));}
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
