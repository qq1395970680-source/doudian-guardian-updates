// A catalog baseline makes a synthetic queue visible without manufacturing
// independent draft proofs or turning these unverified rows into approvals.
export function seedWorkspaceQueueHistories(journal,shopId='900001'){
 for(const [index,r] of journal.priceReviews(shopId).entries())journal.remember({source:'verified-platform-history',complete:true,shopId,productId:r.productId,name:r.name,campaignId:String(490000+index),type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:r.rows.map((s,i)=>({id:String(690000+index*10+i),name:s.name,baseFen:s.baseFen,discount:s.previousDiscount}))},Date.now());
}
