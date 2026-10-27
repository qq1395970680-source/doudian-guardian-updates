import {verifiedRecoveryReceipt} from './recovery-history.mjs';

// Presentation of owned requests and journal evidence, never execution input.
// Pending proposals replace progress rows; superseded proposals stay immutable.
export function buildRecheckProgress({shopId,queue={},reviews=[],checks=[],tasks=[],page=0,pageSize=10}={}){
 const rows=new Map(),reviewById=new Map(reviews.filter(r=>r.shopId===shopId).map(r=>[r.id,r]));
 const pendingByProduct=new Map();for(const review of reviews)if(review.shopId===shopId&&review.status==='pending')pendingByProduct.set(review.productId,Math.max(pendingByProduct.get(review.productId)||0,review.createdAt));
 const activeByProduct=new Map();for(const task of tasks)if(task.shopId===shopId&&!['verified','blocked'].includes(task.phase))for(const plan of task.plans)activeByProduct.set(plan.productId,task);
 const productChecks=new Map(checks.map(c=>[c.productId,c]));
 const verified=new Map();
 for(const task of tasks){
  if(!verifiedRecoveryReceipt(task,shopId))continue;
  for(const plan of task.plans)if((verified.get(plan.productId)?.verifiedAt||0)<task.receipt.verifiedAt)verified.set(plan.productId,
   {taskId:task.id,verifiedAt:task.receipt.verifiedAt,campaignId:task.receipt.campaignId,skuCount:plan.skus.length});
 }
 const names=new Map();for(const task of tasks)for(const plan of task.plans||[])names.set(plan.productId,plan.name);
 for(const request of [...(queue.recent||[]),...(queue.items||[])]){
  if(!shopId||!request.productId||!Number.isFinite(request.requestedAt))continue;
  const previous=rows.get(request.productId);if(previous&&previous.requestedAt>request.requestedAt)continue;
  if((pendingByProduct.get(request.productId)||0)>=request.requestedAt){rows.delete(request.productId);continue;}
  const source=reviewById.get(request.sourceReviewId||request.approvalId),check=productChecks.get(request.productId);
  const recentCheck=check&&check.at>=request.requestedAt?check:null;
  const active=activeByProduct.get(request.productId);
  const receipt=verified.get(request.productId),freshReceipt=receipt?.verifiedAt>=request.requestedAt?receipt:null;
  let state,message,code=request.code||null;
  if(request.state==='complete'){
   state=freshReceipt?'verified':'checked';
   message=freshReceipt?'该次恢复已逐规格独立回读；当前有效性以后续巡检为准。':request.reason||'重新核验已结束，未产生新的恢复提交。';
  }else if(active){state='verifying';message=['submitting','unknown','verifying'].includes(active.phase)?'已有提交正在独立回读，结果确认前不会重复提交。':'恢复任务正在核验草稿与商品规格。';}
  else if(request.state==='deferred'||recentCheck){state='blocked';code=recentCheck?.code||code;message=recentCheck?.message||request.reason||'核对受阻，请查看原因后重新核验。';}
  else if(queue.paused){state='paused';message='核对请求已保存，等待恢复守护或完成登录。';}
  else{state='queued';message=request.reason!==request.requestReason&&request.requestReason?request.reason:'已加入优先核验队列，当前读取收尾后继续。';}
  if(state==='blocked'&&request.state==='deferred'&&['PRODUCT_RECYCLED','OFF_SHELF'].includes(code))state='skipped';
  rows.set(request.productId,{id:request.id,productId:request.productId,name:source?.name||names.get(request.productId)||'商品 '+request.productId,
   sourceReviewId:source?.id||null,requestedAt:request.requestedAt,updatedAt:request.updatedAt||request.requestedAt,
   state,code,message,pending:request.state!=='complete'&&state!=='skipped',retryAt:request.retryAt||null,
   taskId:active?.id||freshReceipt?.taskId||null,campaignId:state==='verified'?freshReceipt.campaignId:null,
   verifiedAt:state==='verified'?freshReceipt.verifiedAt:null,skuCount:state==='verified'?freshReceipt.skuCount:null});
 }
 const records=[...rows.values()].sort((a,b)=>Number(b.pending)-Number(a.pending)||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
 const bounded=(value,fallback)=>Number.isSafeInteger(Number(value))?Number(value):fallback;
 const size=Math.max(1,Math.min(20,bounded(pageSize,10))),pages=Math.max(1,Math.ceil(records.length/size)),current=Math.max(0,Math.min(pages-1,bounded(page,0)));
 return{pending:records.filter(r=>r.pending).length,trackedPendingProductIds:records.filter(r=>r.pending).map(r=>r.productId),total:records.length,page:current,pageSize:size,pages,records:records.slice(current*size,(current+1)*size)};
}
