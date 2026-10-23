import {fingerprint,requireThat} from './policy.mjs';
import {makePriceReviews} from './price-review.mjs';

// This chooses which members need a new read. It never grants a price target,
// rewrites the blocked parent, or authorizes submission from an old draft.
export function isolateDraftPriceFailure(task,failure,now=Date.now()) {
  requireThat(task?.phase==='blocked'&&task.submitAttempts===0&&task.riskAttempts===0,
    'PRICE_ISOLATION_FORBIDDEN','只有明确零提交、零风险确认的阻断草稿可隔离商品');
  requireThat(failure?.code==='PRICE_REVIEW_REQUIRED'&&failure.taskId===task.id&&failure.shopId===task.shopId&&
    failure.plansFingerprint===fingerprint(task.plans)&&Number.isFinite(failure.validatedAt)&&
    failure.validatedAt>0&&failure.validatedAt<=now&&now-failure.validatedAt<=30000,
    'PRICE_ISOLATION_EVIDENCE','缺少本次未提交草稿的新鲜验证记录');
  // Revalidate at the original validation instant. Failure capture may take a
  // few seconds; the strict outer 30-second bound still rejects stale results.
  const proposals=makePriceReviews(task,failure.probe,failure.validatedAt);
  const recorded=failure.recordedReviews;
  requireThat(Array.isArray(recorded)&&recorded.length===proposals.length&&
    new Set(recorded.map(r=>r.productId)).size===recorded.length&&
    new Set(recorded.map(r=>r.id)).size===recorded.length&&recorded.every(r=>r.id&&r.shopId===task.shopId&&
      proposals.some(p=>p.productId===r.productId&&p.key===r.key)),
    'PRICE_ISOLATION_EVIDENCE','本次完整调价建议与已保存记录不一致');
  const errorProducts=new Set(failure.probe.rows.filter(r=>r.errors?.length).map(r=>r.productId));
  requireThat(errorProducts.size>0&&[...errorProducts].every(id=>proposals.some(p=>p.productId===id)),
    'PRICE_ISOLATION_EVIDENCE','存在不能对应明确调价建议的商品错误');
  const rejected=new Set([...errorProducts,...proposals.map(r=>r.productId)]);
  const productIds=task.plans.map(p=>p.productId);
  requireThat(new Set(productIds).size===productIds.length&&[...rejected].every(id=>productIds.includes(id)),
    'PRICE_ISOLATION_EVIDENCE','隔离商品集合不属于原任务');
  const cleanProductIds=productIds.filter(id=>!rejected.has(id));
  if(!cleanProductIds.length)return null;
  return {cleanProductIds,rejectedProductIds:productIds.filter(id=>rejected.has(id)),
    reviewIds:recorded.map(r=>r.id),validatedAt:failure.validatedAt};
}
