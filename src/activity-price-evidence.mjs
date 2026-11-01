import {fingerprint} from './policy.mjs';
const types=['限时抢购','限量抢购'];
export const priceContext=(history,rows)=>fingerprint({history,rows:rows.map(s=>[s.id,s.name,s.baseFen,s.discount,s.saleFen]).sort((a,b)=>a[0].localeCompare(b[0]))});

// Immutable observations only: no task, price or approval is created here.
export function recordedPriceRejections({shopId,productId,reviews=[],tasks=[],now=Date.now()}){
 const failures=[],byTask=new Map(tasks.filter(t=>t.shopId===shopId).map(t=>[t.id,t]));
  for(const review of reviews.filter(r=>r.shopId===shopId&&r.productId===productId&&r.source==='live-platform-removal-export')){
   const proof=review.sourceProof;
   if(!types.includes(review.type)||proof?.source!=='live-platform-removal-export'||proof.complete!==true||proof.shopId!==shopId||
    proof.record?.productId!==productId||proof.activityType!==review.type||!/^[a-f0-9]{64}$/i.test(proof.sha256||'')||
    !Number.isFinite(review.createdAt)||review.createdAt>now+5000||!Number.isFinite(proof.observedAt)||proof.observedAt<=0||
    proof.observedAt>review.createdAt+5000||review.createdAt-proof.observedAt>120000||!review.rows?.length)continue;
   const rows=review.rows.map(r=>({...r,discount:r.previousDiscount,saleFen:r.previousFen}));
   failures.push({type:review.type,state:'blocked',at:review.createdAt,message:proof.record.reason,reviewId:review.id,taskId:null,
    context:priceContext(review.historicalFingerprint,rows),source:'recorded-platform-removal-rejection'});
  }
  for(const review of reviews.filter(r=>r.shopId===shopId&&r.productId===productId&&r.source==='live-platform-draft')){
   const task=byTask.get(review.taskId),plan=task?.plans.find(q=>q.productId===productId);
   if(!plan||task.phase!=='blocked'||task.submitAttempts!==0||!task.reason?.startsWith('PRICE_REVIEW_REQUIRED:')||
    !types.includes(plan.type)||review.type!==plan.type||review.historicalFingerprint!==plan.historicalFingerprint||
    !Number.isFinite(review.createdAt)||review.createdAt<=0||review.createdAt>now+5000||
    review.rows.length!==plan.skus.length||!plan.skus.every(s=>review.rows.some(r=>r.id===s.id&&r.baseFen===s.baseFen&&r.name===s.name&&r.previousFen===s.saleFen&&r.previousDiscount===s.discount)))continue;
   failures.push({type:plan.type,state:'blocked',at:review.createdAt,message:task.reason,reviewId:review.id,taskId:task.id,
    context:priceContext(plan.historicalFingerprint,plan.skus),source:'recorded-platform-draft-rejection'});
  }

 return failures.sort((a,b)=>b.at-a.at);
}
