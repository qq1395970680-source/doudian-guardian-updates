import {fingerprint,saleFen} from './policy.mjs';

// A read-only projection of the execution journal. Never treat these display
// records as current activity observations, approval, or retry input.
export function buildRecoveryHistory({shopId,tasks=[],reviews=[],filter='verified',query='',page=0,pageSize=12}={}){
 const size=Math.min(20,Math.max(1,Math.trunc(Number(pageSize))||12));
 const mode=['verified','pending','blocked','all'].includes(filter)?filter:'verified';
 const approvals=new Map(reviews.filter(r=>r.shopId===shopId).map(r=>[r.id,r]));
 const records=[];
 for(const task of tasks){
  if(!shopId||task.shopId!==shopId||!Array.isArray(task.plans))continue;
  const receipt=task.receipt,receiptValid=task.phase==='verified'&&task.submitAttempts>0&&
   typeof receipt?.campaignId==='string'&&receipt.campaignId.length>0&&Number.isFinite(receipt.verifiedAt)&&receipt.verifiedAt>0&&
   /^[a-f0-9]{64}$/.test(receipt.evidenceFingerprint||'')&&receipt.productCount===task.plans.length&&
   receipt.skuCount===task.plans.reduce((n,p)=>n+(p.skus?.length||0),0)&&task.plans.every(p=>p.shopId===shopId&&p.skus?.length);
  const state=receiptValid?'verified':task.phase==='blocked'?'blocked':'pending';
  for(const plan of task.plans){
   if(plan.shopId!==shopId)continue;
   const approval=approvals.get(plan.priceApprovalId),matching=approval?.productId===plan.productId;
   const skus=(plan.skus||[]).map(s=>{
    const historicalDiscount=s.originalDiscount??s.discount;let historicalSaleFen=null;
    try{historicalSaleFen=saleFen(s.baseFen,historicalDiscount);}catch{}
    return{id:s.id,name:s.name,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen,historicalDiscount,historicalSaleFen};
   });
   records.push({id:task.id+':'+plan.productId,taskId:task.id,productId:plan.productId,name:plan.name||'商品 '+plan.productId,
    phase:task.phase,state,createdAt:task.createdAt,submittedAt:task.submittedAt||null,updatedAt:task.updatedAt,
    verifiedAt:receiptValid?receipt.verifiedAt:null,campaignId:receiptValid?receipt.campaignId:null,
    currentValidity:'historical-receipt',salePriceEvidence:receiptValid?receipt.salePriceEvidence:null,
    mode:!plan.priceApprovalId?'original':matching&&approval.approvalKind==='automatic-price-increase'?'automatic-price-increase':'approved-price',
    reason:task.reason||null,submitted:task.submitAttempts>0,skippedSkuCount:plan.skippedSkuIds?.length||0,skuCount:skus.length,skus});
  }
 }
 records.sort((a,b)=>(b.verifiedAt||b.updatedAt||0)-(a.verifiedAt||a.updatedAt||0)||a.id.localeCompare(b.id));
 const successful=records.filter(r=>r.state==='verified');
 const counts={restoredProducts:new Set(successful.map(r=>r.productId)).size,restoredOccurrences:successful.length,
  verifiedSkus:successful.reduce((n,r)=>n+r.skuCount,0),pendingOccurrences:records.filter(r=>r.state==='pending'&&r.submitted).length,
  blockedOccurrences:records.filter(r=>r.state==='blocked').length};
 const needle=String(query).trim().slice(0,200).toLocaleLowerCase();
 const matching=records.filter(r=>(mode==='all'||r.state===mode)&&(!needle||[r.name,r.productId,r.campaignId,r.taskId,...r.skus.flatMap(s=>[s.name,s.id])].join(' ').toLocaleLowerCase().includes(needle)));
 const pages=Math.max(1,Math.ceil(matching.length/size)),current=Math.max(0,Math.min(pages-1,Math.trunc(Number(page))||0));
 const result={shopId,counts,filter:mode,query:needle,page:current,pageSize:size,pages,total:matching.length,records:matching.slice(current*size,(current+1)*size)};
 return{...result,revision:fingerprint(result)};
}
