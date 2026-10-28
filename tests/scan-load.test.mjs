import test from 'node:test';
import assert from 'node:assert/strict';
import {computerReadBudget, normalizeReadBudget} from '../src/scan-load.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {GuardianService} from '../src/service.mjs';
import {Journal} from '../src/journal.mjs';
import {activeMembershipProofBatches} from '../src/active-membership.mjs';

const GiB = 1024 ** 3;
const pause = ms => new Promise(r => setTimeout(r, ms));
const efficient = () => ({...computerReadBudget({total: 16 * GiB, free: 3 * GiB, cores: 16}), interBatchDelayMs: 0});
test('16GB hosts use two read pages; pressure shrinks to one without changing restoration capacity', () => {
  const normal = efficient();
  assert.equal(normal.detailReaders, 2); assert.equal(normal.listReaders, 1);
  assert.equal(normal.overlapListReads, false); assert.equal(normal.keepMonitorPages, false);
  assert.equal(computerReadBudget({total: 16 * GiB, free: 1 * GiB, cores: 16}).detailReaders, 1);
  assert.equal(computerReadBudget({total: 32 * GiB, free: 12 * GiB, cores: 16}).detailReaders, 4);
  assert.equal(computerReadBudget({total: 32 * GiB, free: 1 * GiB, cores: 16}).detailReaders, 1);
  assert.equal(computerReadBudget({total: NaN, free: 1, cores: 16}).detailReaders, 1);
  assert.equal(normalizeReadBudget({detailReaders: 100, listReaders: -1}).detailReaders, 1);
});

test('a low-load inventory drains every two-page batch and still visits the complete shop', async () => {
  const journal = new Journal(':memory:');
  const platform = new DoudianPlatform({browser: {}, policy: {shopId: '900001'}, journal, resourceBudget: efficient});
  const campaigns = Array.from({length: 9}, (_, i) => ({id: String(400001 + i), name: '活动' + i, type: '限时抢购',
    status: '进行中', startAt: Date.now() - 1000, endAt: Date.now() + 86400000}));
  platform.listActive = async () => ({complete: true, observedAt: Date.now(), campaigns});
  let active = 0, peak = 0, calls = 0;
  const batches = [];
  platform.detail = async c => {
    peak = Math.max(peak, ++active); calls++; await pause(5); active--;
    return {complete: true, observedAt: Date.now(), rules: {noLimit: true, noPerUserLimit: true, noWarmup: true, orderMinutes: 30},
      products: [{productId: String(Number(c.id) + 100000), name: c.name,
        skus: [{id: String(Number(c.id) + 200000), name: '规格', baseFen: 10000, discount: 50, saleFen: 5000}]}]};
  };
  try {
    const result = await platform.discover({historyReadLimit: 0,
      onReadBoundary: async ({reads}) => {assert.equal(active, 0); if (reads.length) batches.push(reads.length);}});
    assert.equal(peak, 2); assert.equal(calls, 9); assert.deepEqual(batches, [2, 2, 2, 2, 1]);
    assert.equal(result.activeComplete, true); assert.equal(result.baselines.length, 9);
  } finally { journal.close(); }
});

test('low-load list reads visit both statuses in sequence and leave no monitor pages retained', async () => {
  const journal = new Journal(':memory:');
  const platform = new DoudianPlatform({browser: {}, policy: {shopId: '900001'}, journal, resourceBudget: efficient});
  platform.ensure = async () => {};
  let active = 0, peak = 0; const calls = [];
  platform.list = async ({status, monitor}) => {
    calls.push({status, monitor}); peak = Math.max(peak, ++active); await pause(5); active--;
    return {complete: true, observedAt: Date.now(), campaigns: []};
  };
  try {
    const listing = await platform.peekActive();
    assert.equal(peak, 1); assert.equal(listing.complete, true);
    assert.deepEqual(calls, [{status: '进行中', monitor: false}, {status: '未开始', monitor: false}]);
  } finally { journal.close(); }
});

test('low-load background polls start only at a drained detail boundary', async () => {
  const journal = new Journal(':memory:'); let polls = 0;
  const platform = {readBudget: efficient, peekActive: async () => {polls++; return {complete: true, campaigns: []};}};
  const service = new GuardianService({journal, platform, policy: {shopId: '900001'}});
  service.priorityListing = {complete: true, campaigns: []};
  try {
    service.beginPriorityPoll(); await pause(1); assert.equal(polls, 0);
    service.beginPriorityPoll({atBoundary: true}); await service.settlePriorityPoll(); assert.equal(polls, 1);
  } finally { journal.close(); }
});

test('a failed status query remains incomplete and never becomes an empty shop', async () => {
  const journal = new Journal(':memory:');
  const platform = new DoudianPlatform({browser: {}, policy: {shopId: '900001'}, journal, resourceBudget: efficient});
  platform.ensure = async () => {};
  platform.list = async ({status}) => {
    if (status === '未开始') throw Object.assign(new Error('status page failed'), {code: 'LOAD_TIMEOUT'});
    return {complete: true, observedAt: Date.now(), campaigns: []};
  };
  try { await assert.rejects(platform.peekActive(), {code: 'LOAD_TIMEOUT'}); }
  finally { journal.close(); }
});

test('existing-activity proof waves obey the two-page budget while confirming every requested product', async () => {
  const now = Date.now(); let readers = 0, peak = 0;
  const baselines = Array.from({length: 8}, (_, i) => ({shopId: '900001', productId: String(300001 + i), campaignId: String(400001 + i)}));
  const campaigns = baselines.map(b => ({id: b.campaignId, name: '活动' + b.campaignId, type: '限时抢购',
    status: '进行中', startAt: now - 1000, endAt: now + 86400000, risk: false}));
  const platform = {policy: {shopId: '900001'}, readBudget: efficient, check() {},
    listActive: async () => ({complete: true, observedAt: Date.now(), campaigns}),
    detail: async c => {peak = Math.max(peak, ++readers); await pause(5); readers--;
      return {complete: true, observedAt: Date.now(), products: [{productId: baselines.find(b => b.campaignId === c.id).productId}]};}};
  const proved = [];
  for await (const batch of activeMembershipProofBatches(platform, baselines)) {
    assert.equal(readers, 0); proved.push(...batch);
  }
  assert.equal(peak, 2); assert.equal(proved.length, 8);
  assert.ok(proved.every(p => p.loss.active === true));
  assert.deepEqual(proved.map(p => p.productId), baselines.map(b => b.productId));
});
