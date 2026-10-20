import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHistorical, planOriginalRestore, proveDraft, proveReadback} from '../src/policy.mjs';

const now = 1800000000000, week = 7 * 86400000;
function example() {
  const baseline = {source: 'verified-platform-history', complete: true, shopId: '900001',
    productId: '300001', name: '限量商品', campaignId: '400001', type: '限量抢购',
    rules: {noLimit: false, noPerUserLimit: true, noWarmup: true, orderMinutes: 30, autoRenew: true},
    durationMs: week, activityLimit: 1000,
    skus: [{id: '500001', name: '规格甲', baseFen: 10000, discount: 50},
      {id: '500002', name: '规格乙', baseFen: 20000, discount: 75}]};
  const current = {shopId: baseline.shopId, productId: baseline.productId, complete: true,
    observedAt: now, skus: structuredClone(baseline.skus)};
  const policy = {shopId: baseline.shopId, originalRiskAllowed: true, allowMissingHistoricalSkus: true};
  return {baseline, current, policy};
}
function planned() {
  const {baseline, current, policy} = example();
  const plan = planOriginalRestore(baseline, current, policy, now);
  const observation = {kind: 'draft', shopId: plan.shopId, title: '限量核验', type: plan.type,
    rules: structuredClone(plan.rules), complete: true, observedAt: now, startAt: now, endAt: now + week,
    productLimits: [{productId: plan.productId, activityLimit: 1000}],
    rows: plan.skus.map(s => ({...s, productId: plan.productId})), warnings: [], dialogs: []};
  return {plan, observation, task: {id: 't', shopId: plan.shopId, title: observation.title, plans: [plan]}};
}
test('limited campaign preserves product quota and different per-SKU prices', () => {
  const {baseline, current, policy} = example();
  assert.equal(validateHistorical(baseline), baseline);
  const plan = planOriginalRestore(baseline, current, policy, now);
  assert.equal(plan.activityLimit, 1000);
  assert.equal(plan.durationMs, week);
  assert.equal(plan.rules.autoRenew, true);
  assert.deepEqual(plan.skus.map(s => s.discount), [50, 75]);
});
test('limited campaign rejects absent, fractional or excessive product quotas', () => {
  for (const activityLimit of [undefined, 0, -1, 1001, 1.5, '1000']) {
    const {baseline} = example(); baseline.activityLimit = activityLimit;
    assert.throws(() => validateHistorical(baseline), {code: 'LIMITED_QUANTITY'});
  }
});
test('limited campaign requires explicit renewal and supported duration', () => {
  const {baseline} = example(); delete baseline.rules.autoRenew;
  assert.throws(() => validateHistorical(baseline), {code: 'LIMITED_RULES'});
  baseline.rules.autoRenew = true; baseline.durationMs = 31 * 86400000;
  assert.throws(() => validateHistorical(baseline), {code: 'LIMITED_DURATION'});
});
test('seven-day draft verifies actual product quota and renewal rather than only prices', () => {
  const {task, observation} = planned();
  assert.ok(proveDraft(task, observation, now));
  observation.productLimits[0].activityLimit = 999;
  assert.throws(() => proveDraft(task, observation, now), {code: 'LIMITED_READBACK'});
  observation.productLimits[0].activityLimit = 1000;
  observation.rules.autoRenew = false;
  assert.throws(() => proveDraft(task, observation, now), {code: 'DRAFT_RULES'});
});
test('limited draft cannot silently fall back to 48 hours or lose quantity evidence', () => {
  const {task, observation} = planned();
  observation.endAt = now + 48 * 3600000;
  assert.throws(() => proveDraft(task, observation, now), {code: 'DRAFT_TIME'});
  observation.endAt = now + week; delete observation.productLimits;
  assert.throws(() => proveDraft(task, observation, now), {code: 'LIMITED_READBACK'});
});
test('independent limited readback checks duration, quota and membership', () => {
  const {plan, observation} = planned();
  Object.assign(observation, {status: '进行中', campaignId: '400002'});
  const receipt = proveReadback([plan], observation, {title: observation.title, now});
  assert.equal(receipt.skuCount, 2);
  observation.productLimits.push({...observation.productLimits[0]});
  assert.throws(() => proveReadback([plan], observation, {now}), {code: 'LIMITED_READBACK'});
});
