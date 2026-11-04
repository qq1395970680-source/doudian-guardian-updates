import {dualPriceProposalReady} from './dual-activity-recovery.mjs';
const unresolved=task=>!['verified','blocked'].includes(task.phase);
const fresh=(review,now)=>review?.status==='pending'&&Array.isArray(review.rows)&&review.rows.length>0&&
 Number.isFinite(review.createdAt)&&review.createdAt<=now+5000&&Number.isFinite(review.expiresAt)&&review.expiresAt>now;

// A presentation-only, single owner per product. It never changes a task,
// approves prices, or supplies execution evidence.
export function workspaceOwnership({shopId,products=[],reviews=[],tasks=[],checks=[],requests=[],hiddenProductIds=[],careEnabled=false,dualEnabled=false,dualDecisions=new Map(),now=Date.now()}={}){
 const hidden=new Set(hiddenProductIds),catalog=new Map(products.map(p=>[p.productId,p]));
 const scoped=reviews.filter(r=>r.shopId===shopId),latest=new Map();
 for(const review of scoped.filter(r=>['pending','declined'].includes(r.status)).sort((a,b)=>b.createdAt-a.createdAt))if(!latest.has(review.productId))latest.set(review.productId,review);
 const active=new Map();for(const task of tasks.filter(t=>t.shopId===shopId&&unresolved(t)))for(const plan of task.plans||[])if(!active.has(plan.productId)||active.get(plan.productId).updatedAt<task.updatedAt)active.set(plan.productId,task);
 const byCheck=new Map(checks.filter(c=>c.shopId===shopId).map(c=>[c.productId,c]));
 const byRequest=new Map();for(const request of requests.filter(r=>r.state!=='complete'))if(!byRequest.has(request.productId)||(byRequest.get(request.productId).requestedAt||0)<request.requestedAt)byRequest.set(request.productId,request);
 const ids=new Set([...catalog.keys(),...latest.keys(),...active.keys(),...byCheck.keys(),...byRequest.keys()]),byProduct=new Map(),priceReviewIds=[],priceProductIds=[];
 for(const productId of ids){
  const product=catalog.get(productId),dual=dualDecisions.get(productId),paired=dual?.approvalAllowed?scoped.find(r=>r.id===dual.schemes?.find(s=>s.type===dual.plan?.type)?.reviewId)||scoped.find(r=>dual.schemes?.some(s=>s.reviewId===r.id)):null,review=paired||latest.get(productId),task=active.get(productId),check=byCheck.get(productId),request=byRequest.get(productId);
  if(hidden.has(productId)||product?.excluded)continue;
  if(!task&&(product?.current?.length||product?.scheduled?.length))continue;
  let owner=null,category=null;
  if(task){owner='blockers';category=['unknown','submitting','verifying'].includes(task.phase)?'verification':'processing';}
  else if(fresh(review,now)){if(dualEnabled){if(dualPriceProposalReady(dual)){owner='prices';category='price-review';priceReviewIds.push(review.id);priceProductIds.push(productId);}else{owner='blockers';category=dual?.declined?'declined':dual?.schemes?.some(s=>s.classification==='non-reducing')?'processing':'needs-evidence';}}else if(careEnabled&&!review.rows.some(row=>row.saleFen<row.previousFen)){owner='blockers';category=review.skippedSkuIds?.length?'needs-evidence':'processing';}else{owner='prices';category='price-review';priceReviewIds.push(review.id);priceProductIds.push(productId);}}
  else if(review||check||request){owner='blockers';category=review?.status==='declined'?'declined':request&&request.state==='pending'?'processing':check&&!['PRICE_REVIEW_REQUIRED','SKU_RATIO_REVIEW_REQUIRED','PRICE_RECONFIRM_REQUIRED','ORIGINAL_PRICE_BLOCKED'].includes(check.code)?'read-blocked':'needs-evidence';}
  const carePending=!!(!task&&(dualEnabled&&owner==='blockers'&&fresh(review,now)||careEnabled&&!dualEnabled&&fresh(review,now)&&!review.rows.some(row=>row.saleFen<row.previousFen)));
  if(owner)byProduct.set(productId,{productId,owner,category,carePending,blockedReason:task?'此商品已有未完成或结果未知的提交，先独立回读，不能重复提交。':dualEnabled&&owner==='blockers'?(dual?.blockedReason||'后台继续分别核验两种方案；未证明两种都必须降价前，无需你确认。'):careEnabled&&fresh(review,now)&&!review.rows.some(row=>row.saleFen<row.previousFen)?review.skippedSkuIds?.length?'规格尚未完整对应，后台继续核对后再判断不降价恢复。':'后台正在核验本类型的不降价调整方案，无需手动价格确认。':null,reviewId:review?.id||null,reviewFresh:fresh(review,now),activeTask:task?{id:task.id,phase:task.phase}:null,request:request||null,dualDecision:dual||null});
 }
 return {byProduct,priceReviewIds,priceProductIds};
}
