import {freemem, totalmem, availableParallelism} from 'node:os';

const GiB = 1024 ** 3;
// This controls read scheduling only. Evidence ages, SKU checks, submission
// capacity and per-shop authorizations are deliberately outside this policy.
export function computerReadBudget(resources = {free: freemem(), total: totalmem(), cores: availableParallelism()}) {
  const {free, total, cores} = resources;
  const valid = Number.isFinite(free) && Number.isFinite(total) && total > 0 && free >= 0 && free <= total;
  let readers = 1, reason = '资源信息暂不可用，减少并发';
  if (valid) {
    if (free < 2 * GiB || free / total < 0.1) reason = '可用内存偏低，优先保证前台流畅';
    else if (cores <= 4) reason = '减少后台占用，优先保证前台流畅';
    else if (total >= 26 * GiB && free >= 8 * GiB) { readers = 4; reason = '可用资源充足'; }
    else if (total >= 20 * GiB && free >= 5 * GiB) { readers = 3; reason = '按当前可用资源调整'; }
    else { readers = 2; reason = '减少后台页面占用，优先保证前台流畅'; }
  }
  return Object.freeze({detailReaders: readers, listReaders: readers >= 4 ? 2 : 1,
    overlapListReads: readers >= 4, keepMonitorPages: false,
    interBatchDelayMs: readers === 1 ? 500 : readers === 2 ? 200 : 0,
    idleMs: readers <= 2 ? 30000 : 10000, reason,
    availableMemoryGB: valid ? Math.round(free / GiB * 100) / 100 : null});
}

export function normalizeReadBudget(value) {
  const integer = (v, min, max, fallback) => Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return {...value, detailReaders: integer(value?.detailReaders, 1, 6, 1),
    listReaders: integer(value?.listReaders, 1, 2, 1),
    overlapListReads: value?.overlapListReads === true, keepMonitorPages: value?.keepMonitorPages === true,
    interBatchDelayMs: integer(value?.interBatchDelayMs, 0, 1000, 200),
    idleMs: integer(value?.idleMs, 10000, 120000, 30000)};
}
