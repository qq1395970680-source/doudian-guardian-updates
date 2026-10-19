import { createHash } from 'node:crypto';

export class GuardError extends Error {
  constructor(code, message, detail = null) { super(message); this.code = code; this.detail = detail; }
}
export function requireThat(value, code, message) {
  if (!value) throw new GuardError(code, message);
}
export const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const normalizeName = name => String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
export function id(value, label = '编号') {
  requireThat(typeof value === 'string' && /^\d{3,25}$/.test(value), 'INVALID_ID', `${label}必须为完整数字文本`);
  return value;
}
export function saleFen(baseFen, discount) {
  requireThat(Number.isSafeInteger(baseFen) && baseFen > 0 && baseFen <= 100000000,
    'INVALID_PRICE', '原价必须为有效的整数分');
  requireThat(Number.isInteger(discount) && discount >= 10 && discount <= 99,
    'INVALID_DISCOUNT', '折扣必须为原价的整数百分比');
  return Math.round(baseFen * discount / 100);
}
function uniqueRows(rows, label, allowMissingIds = false) {
  requireThat(Array.isArray(rows) && rows.length > 0, 'EMPTY_SKUS', `${label}规格为空`);
  const seen = new Set();
  for (const row of rows) {
    if(row.id != null) id(row.id, '规格ID');
    else requireThat(allowMissingIds && row.idSource==='unavailable-in-create-form', 'INVALID_ID', '规格 ID 来源不完整');
    const key=row.id || normalizeName(row.name);
    requireThat(!seen.has(key), 'DUPLICATE_SKU', `${label}出现重复规格`); seen.add(key);
    requireThat(normalizeName(row.name), 'INVALID_SKU', `${label}规格名称不完整`);
    requireThat(Number.isSafeInteger(row.baseFen) && row.baseFen > 0, 'INVALID_PRICE', `${label}原价不完整`);
  }
}
export function validateHistorical(baseline) {
  requireThat(baseline && baseline.source === 'verified-platform-history' && baseline.complete === true,
    'UNVERIFIED_HISTORY', '必须使用完整核验的平台历史，诊断日志不能用于恢复');
  id(baseline.shopId, '店铺ID'); id(baseline.productId, '商品ID'); uniqueRows(baseline.skus, '历史');
  requireThat(baseline.rules && ['限时抢购', '普通降价促销'].includes(baseline.type), 'UNSUPPORTED_RULE', '历史活动规则不完整');
  const r=baseline.rules;
  requireThat(r.noLimit===true && r.noPerUserLimit===true && r.noWarmup===true && Number.isInteger(r.orderMinutes) && r.orderMinutes>0 && r.orderMinutes<=1440,
    'UNSUPPORTED_RULE','仅支持已核对的不限量、不限购、不预热及明确订单取消时间');
  for (const sku of baseline.skus) saleFen(sku.baseFen, sku.discount);
  return baseline;
}
export function planOriginalRestore(baseline, current, policy, now = Date.now()) {
  validateHistorical(baseline);
  requireThat(current?.shopId === baseline.shopId && policy?.shopId === baseline.shopId,
    'SHOP_MISMATCH', '当前店铺与历史及授权配置不一致');
  requireThat(current.productId === baseline.productId, 'PRODUCT_MISMATCH', '当前商品与历史不一致');
  requireThat(!policy.excludedProductIds?.includes(baseline.productId), 'EXCLUDED', '商品已排除');
  requireThat(!current.offShelf, 'OFF_SHELF', '商品已明确下架');
  requireThat(!current.activeCampaign, 'ALREADY_ACTIVE', '商品已有有效活动');
  requireThat(!baseline.pending && !baseline.paused, 'PENDING', '存在未核实提交或暂停记录');
  requireThat(current.complete === true && current.observedAt > 0 && now - current.observedAt <= 120000 && current.observedAt <= now + 5000,
    'STALE_OR_INCOMPLETE', '当前完整规格证明过期或不完整');
  uniqueRows(current.skus, '当前', true);
  const used = new Set(), mappings = [];
  for (const row of current.skus) {
    const matches = row.id != null ? baseline.skus.filter(saved => saved.id === row.id) :
      baseline.skus.filter(saved => normalizeName(saved.name) === normalizeName(row.name));
    requireThat(matches.length === 1 && !used.has(matches[0].id), 'NEW_OR_AMBIGUOUS_SKU', '存在新增规格或不唯一的历史映射');
    const saved = matches[0];
    requireThat(normalizeName(saved.name) === normalizeName(row.name), 'SKU_CHANGED', '规格名称发生变化');
    requireThat(saved.baseFen === row.baseFen, 'BASE_PRICE_CHANGED', '规格原价发生变化');
    requireThat(saved.discount >= 10 && saved.discount <= 95, 'TEMPLATE_RANGE', '原折扣超出已验证官方导入模板范围');
    used.add(saved.id);
    mappings.push({ id: saved.id, historicalId: saved.id, observedId:row.id??null, mapping:row.id?'id-and-name-and-base':'unique-name-and-base', name: normalizeName(row.name), baseFen: row.baseFen,
      discount: saved.discount, saleFen: saleFen(saved.baseFen, saved.discount) });
  }
  const skippedSkuIds = baseline.skus.filter(s => !used.has(s.id)).map(s => s.id);
  requireThat(!skippedSkuIds.length || policy.allowMissingHistoricalSkus === true, 'MISSING_SKUS', '历史规格缺失，未获得保留子集的授权');
  const result = { shopId: baseline.shopId, productId: baseline.productId, name: baseline.name,
    type: baseline.type, rules: structuredClone(baseline.rules), skus: mappings, skippedSkuIds,
    historicalFingerprint: fingerprint(baseline), currentFingerprint: fingerprint(current), observedAt: current.observedAt,
    originalRiskAllowed: policy.originalRiskAllowed === true };
  return { ...result, fingerprint: fingerprint(result) };
}
export function proveReadback(plans, observation, { title, now = Date.now(), exactMembership = true } = {}) {
  requireThat(plans.length > 0 && observation?.complete === true, 'READBACK_INCOMPLETE', '没有完整独立回读');
  requireThat(observation.shopId === plans[0].shopId && observation.observedAt > 0 && observation.observedAt <= now + 5000 && now - observation.observedAt <= 120000,
    'READBACK_IDENTITY', '回读店铺或时间无效');
  if (title) requireThat(observation.title === title, 'READBACK_JOURNAL', '回读活动与任务名称不一致');
  requireThat(['进行中', '未开始'].includes(observation.status) && observation.campaignId, 'NOT_ACTIVE', '活动尚未核实生效');
  const expected = plans.flatMap(p => p.skus.map(s => ({ ...s, productId: p.productId })));
  const actual = observation.rows || [], keys = new Set(actual.map(r => `${r.productId}:${r.id}`));
  requireThat(keys.size === actual.length, 'DUPLICATE_READBACK', '回读规格重复');
  if (exactMembership) requireThat(expected.length === actual.length, 'READBACK_MEMBERSHIP', '活动规格集合不一致');
  for (const row of expected) {
    const found = actual.find(r => r.productId === row.productId && r.id === row.id);
    requireThat(found && found.baseFen === row.baseFen && found.discount === row.discount && found.saleFen === row.saleFen,
      'READBACK_PRICE', '回读原价、折扣或活动价不一致');
  }
  for (const plan of plans) requireThat(fingerprint(observation.rules) === fingerprint(plan.rules) && observation.type === plan.type,
    'READBACK_RULES', '回读活动规则不一致');
  return { campaignId: observation.campaignId, verifiedAt: now, productCount: plans.length, skuCount: expected.length,
    salePriceEvidence:actual.every(r=>r.saleSource==='observed')?'observed':'verified-base-and-discount-with-computed-sale',
    evidenceFingerprint: fingerprint(observation) };
}
export function proveDraft(task, observation, now = Date.now()) {
  return checkDraft(task,observation,now,false);
}
function checkDraft(task, observation, now, continuation) {
  requireThat(observation?.kind === 'draft' && observation.title === task.title && observation.shopId === task.shopId && observation.complete === true,
    'DRAFT_IDENTITY', '创建草稿与当前任务不一致');
  requireThat(observation.observedAt > 0 && now - observation.observedAt <= 30000 && observation.observedAt <= now + 5000,
    'DRAFT_EXPIRED', '草稿校验已过期');
  requireThat(observation.warnings?.length === 0 && observation.dialogs?.length === 0, 'DRAFT_WARNING', '草稿仍有未解决的提示或弹窗');
  const original=continuation?task.draftProof?.observation:null;
  const validTime=original?observation.startAt===original.startAt&&observation.endAt===original.endAt&&observation.endAt>now:
    observation.startAt > now - 300000 && observation.startAt <= now + 300000;
  requireThat(validTime && observation.endAt - observation.startAt === 48 * 3600000,
    'DRAFT_TIME', '草稿时间不是已核对的未来48小时');
  // Reuse only the comparison contract; the observation remains explicitly a
  // draft and is never stored as an independent live verification receipt.
  const expected = task.plans.flatMap(p => p.skus.map(s => ({...s,productId:p.productId})));
  const rows = observation.rows || [];
  requireThat(rows.length === expected.length && new Set(rows.map(r=>`${r.productId}:${r.id}`)).size === rows.length,
    'DRAFT_MEMBERSHIP', '草稿商品规格数量不一致或重复');
  for (const row of expected) {
    const actual = rows.find(r=>r.productId===row.productId&&r.id===row.id);
    requireThat(actual && normalizeName(actual.name)===normalizeName(row.name) && actual.baseFen===row.baseFen && actual.discount===row.discount && actual.saleFen===row.saleFen,
      'DRAFT_PRICE', '草稿规格、原价、折扣或活动价不一致');
  }
  for(const plan of task.plans) requireThat(observation.type===plan.type&&fingerprint(observation.rules)===fingerprint(plan.rules),
    'DRAFT_RULES','草稿活动规则与历史不一致');
  return {taskId:task.id,at:now,fingerprint:fingerprint(observation),materialFingerprint:draftMaterial(observation),plansFingerprint:fingerprint(task.plans),observation:structuredClone(observation)};
}

export function proveOriginalRisk(task,observation,now=Date.now()){
  requireThat(task&&['submitting','unknown','verifying'].includes(task.phase)&&task.submitAttempts===1&&task.riskAttempts===0&&
    task.plans.every(plan=>plan.originalRiskAllowed||plan.approvedRiskAllowed&&plan.priceApprovalId&&plan.priceApprovalKey)&&task.draftProof&&Array.isArray(observation?.dialogs)&&observation.dialogs.length===1,
    'RISK_PROOF','原折扣确认必须对应尚未确认的原提交记录');
  const dialog=observation.dialogs[0],count=Number(dialog.replace(/\s/g,'').match(/^(\d+)个商品存在低价风险，请谨慎新建/)?.[1]);
  const ids=[...new Set([...dialog.matchAll(/ID[：:]\s*(\d{3,25})(?!\d)/g)].map(m=>m[1]))];
  requireThat(count>0&&count<=task.plans.length&&ids.length===count&&ids.every(id=>task.plans.some(plan=>plan.productId===id))&&
    /预估最低到手价/.test(dialog)&&/仍要创建/.test(dialog),'RISK_PROOF','低价提示中的完整商品集合尚未对应本次任务');
  const verified=checkDraft(task,{...observation,dialogs:[]},now,true);
  requireThat(verified.materialFingerprint===task.draftProof.materialFingerprint&&verified.plansFingerprint===task.draftProof.plansFingerprint,
    'RISK_PROOF','风险提示下的商品、规则、时间或价格与原提交草稿不同');
  return verified;
}

export function draftMaterial(o){
  return fingerprint({shopId:o.shopId,title:o.title,type:o.type,rules:o.rules,startAt:o.startAt,endAt:o.endAt,
    rows:[...(o.rows||[])].map(r=>({productId:r.productId,id:r.id,name:normalizeName(r.name),baseFen:r.baseFen,discount:r.discount,saleFen:r.saleFen})).sort((a,b)=>(a.productId+':'+a.id).localeCompare(b.productId+':'+b.id))});
}
