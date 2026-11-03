const types=['限时抢购','限量抢购'];
const classifications=new Set(['non-reducing','reduction-required','pending','unavailable']);
export function workspaceSchemes(decision){return types.map(type=>{
 const scheme=decision?.schemes?.find(s=>s.type===type),classification=classifications.has(scheme?.classification)?scheme.classification:'pending';
 return{type,classification,reason:scheme?.reason||decision?.blockedReason||'尚未完成本方案的独立核验，不能认定需要降价。',evidenceAt:scheme?.evidenceAt||null,reviewId:scheme?.reviewId||null};
});}
export function buildRecoveryWorkspace({shopId,catalog,reviews=[],checks=[],ownership,dualEnabled=false,scope='confirm',query='',page=0,pageSize=10,hiddenProductIds=[],now=Date.now()}={}){
 const products=new Map((catalog?.products||[]).map(p=>[p.productId,p])),hidden=new Set(hiddenProductIds),confirm=[],automatic=[];
 for(const assignment of ownership?.byProduct?.values()||[]){
  const product=products.get(assignment.productId);if(!product||hidden.has(product.productId)||product.excluded)continue;
  const decision=assignment.dualDecision,schemes=workspaceSchemes(decision),review=reviews.find(r=>r.id===assignment.reviewId),actualTask=assignment.activeTask,check=checks.find(c=>c.productId===assignment.productId),latestFailure=check?.message&&(!decision||check.at>=decision.createdAt&&(!check.contextKey||check.contextKey===decision.historicalFingerprint))&&!['DUAL_REDUCTION_REQUIRED','DUAL_CHECK_PENDING'].includes(check.code)?check.message:null;
  if(decision?.resolved&&!actualTask&&(!assignment.request||assignment.request.state==='complete'))continue;
  const allowed=dualEnabled&&assignment.owner==='prices'&&review?.status==='pending'&&review.expiresAt>now&&decision?.valid&&decision.approvalAllowed===true&&schemes.every(s=>s.classification==='reduction-required');
  const record={productId:product.productId,name:product.name||review?.name||'商品 '+product.productId,category:allowed?'price-confirmation':!dualEnabled&&!actualTask?'setup-required':latestFailure&&!actualTask?'read-blocked':assignment.category,...(!dualEnabled&&!actualTask?{statusLabel:'等待开启双方案'}:{}),
   summary:allowed?'两种方案都已核验，均需至少一个规格降价，请核对确切价格。':actualTask?assignment.blockedReason:!dualEnabled?'启用双方案省心守护后，后台会先比较两种活动。':latestFailure?'最近核验：'+latestFailure:decision?.declined?'已保留暂不调价的选择，后台继续寻找不降价方案。':decision?.schemes?.some(s=>s.classification==='non-reducing')?'已有不降价方案，后台继续核验恢复。':assignment.blockedReason||'后台继续核验两种方案，无需手动调整价格。',
   updatedAt:Math.max(decision?.createdAt||0,assignment.request?.updatedAt||0,assignment.request?.requestedAt||0,actualTask?.updatedAt||0,review?.createdAt||0),
   reviewId:null,pricingReviewId:review?.id||null,canRecheck:dualEnabled&&!actualTask,verificationState:actualTask?.phase||'checking',approvalAllowed:!!allowed,pairKey:decision?.pairKey||null,schemes};
  (allowed?confirm:automatic).push(record);
 }
 const latestHistory=new Map();for(const r of reviews.filter(r=>r.shopId===shopId&&!hidden.has(r.productId)&&!products.get(r.productId)?.excluded&&(r.status==='approved'||r.status==='declined'&&r.expiresAt>now)).sort((a,b)=>(b.approvedAt||b.declinedAt||b.createdAt)-(a.approvedAt||a.declinedAt||a.createdAt)))if(!latestHistory.has(r.productId))latestHistory.set(r.productId,r);
 const history=[...latestHistory.values()].map(r=>({productId:r.productId,name:r.name||products.get(r.productId)?.name||'商品 '+r.productId,category:r.status,statusLabel:r.status==='declined'?'已暂缓调价':r.rows?.some(row=>row.saleFen<row.previousFen)?'已确认降价':'已确认价格',summary:r.status==='approved'?'最近一次已确认的确切价格；所有恢复记录仍保留。':'已保留最近一次暂不调整的选择。',updatedAt:r.approvedAt||r.declinedAt||r.createdAt,reviewId:r.id,pricingReviewId:r.id,canRecheck:false,verificationState:'history',approvalAllowed:false,schemes:[]}));
 const counts={confirm:confirm.length,automatic:automatic.length,history:history.length},mode=['confirm','automatic','history'].includes(scope)?scope:'confirm',needle=query.trim().toLocaleLowerCase();
 const selected={confirm,automatic,history}[mode].filter(r=>!needle||(r.name+' '+r.productId).toLocaleLowerCase().includes(needle)).sort((a,b)=>b.updatedAt-a.updatedAt||a.productId.localeCompare(b.productId));
 const size=Math.min(20,Math.max(1,Number.isSafeInteger(Number(pageSize))?Number(pageSize):10)),pages=Math.max(1,Math.ceil(selected.length/size)),current=Math.max(0,Math.min(pages-1,Number.isSafeInteger(Number(page))?Number(page):0));
 return{shopId,scope:mode,counts,total:selected.length,page:current,pageSize:size,pages,records:selected.slice(current*size,(current+1)*size)};
}
