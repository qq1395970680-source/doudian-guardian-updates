import {workspaceOwnership} from './workspace-ownership.mjs';
import {priceContext as context,recordedPriceRejections} from './activity-price-evidence.mjs';
import {verifiedRecoveryReceipt} from './recovery-history.mjs';
const types=['限时抢购','限量抢购'];
// Display only. A failed source activity or an untested option never proves
// that the other type is rejected, and none of these rows authorize execution.
export function buildRecoveryBlockers({shopId,catalog,tasks=[],reviews=[],checks=[],targets=[],now=Date.now(),originalPricesOnly=false,careEnabled=false,requests=[],requestsPaused=false,hiddenProductIds=[],ownership=null,includePriceOwned=false,filter='all',page=0,pageSize=10,query=''}={}){
 originalPricesOnly=originalPricesOnly&&!careEnabled;
 ownership??=workspaceOwnership({shopId,products:catalog?.products||[],reviews,tasks,checks,requests,hiddenProductIds,careEnabled,now});
 const records=[],scoped=tasks.filter(t=>t.shopId===shopId),byTask=new Map(scoped.map(t=>[t.id,t]));
 const targetByProduct=new Map(targets.filter(r=>r?.shopId===shopId).map(r=>[r.productId,r]));
 for(const p of catalog?.products||[]){
  if(p.excluded||hiddenProductIds.includes(p.productId))continue;
  const assignment=ownership.byProduct.get(p.productId);if(!assignment?.activeTask&&(p.current.length||p.scheduled.length))continue;if(assignment?.owner==='prices'&&!includePriceOwned)continue;
  const request=assignment?.request,latestReview=reviews.filter(r=>r.shopId===shopId&&r.productId===p.productId&&['pending','declined'].includes(r.status)).sort((a,b)=>b.createdAt-a.createdAt)[0];
  const check=checks.find(c=>c.shopId===shopId&&c.productId===p.productId),related=scoped.filter(t=>t.plans.some(q=>q.productId===p.productId));
  const active=related.some(t=>!['verified','blocked'].includes(t.phase));
  const failures=recordedPriceRejections({shopId,productId:p.productId,reviews,tasks:scoped,now});
  const latestFailure=failures.sort((a,b)=>b.at-a.at)[0],target=targetByProduct.get(p.productId);
  const currentContext=target?context(target.historicalFingerprint,target.rows):latestFailure?.context;
  const schemes=Object.fromEntries(types.map(type=>{
   const failure=failures.find(f=>f.type===type),success=related.filter(t=>verifiedRecoveryReceipt(t,shopId)&&t.plans.some(q=>q.productId===p.productId&&q.type===type))
    .sort((a,b)=>b.receipt.verifiedAt-a.receipt.verifiedAt)[0];
   if(success&&(!failure||success.receipt.verifiedAt>failure.at))return[type,{state:'verified',at:success.receipt.verifiedAt,message:'该次恢复已回读，当前有效性以后续巡检为准'}];
   return[type,failure?{...failure,outdated:failure.context!==currentContext}:{state:'unverified',at:null,message:'尚无该方案对应的明确平台拒绝记录'}];
  }));
  const bothBlocked=!active&&types.every(type=>schemes[type].state==='blocked'&&!schemes[type].outdated)&&schemes[types[0]].context===schemes[types[1]].context;
  const singleBlocked=types.some(type=>schemes[type].state==='blocked'&&!schemes[type].outdated);
  const pendingReview=reviews.some(r=>r.shopId===shopId&&r.productId===p.productId&&r.status==='pending'&&!(Number.isFinite(r.expiresAt)&&r.expiresAt<=now));
  if(!bothBlocked&&!singleBlocked&&!check&&!active&&!pendingReview&&!request&&latestReview?.status!=='declined')continue;
  const updatedAt=Math.max(check?.at||0,...types.map(type=>schemes[type].at||0),...related.map(t=>t.updatedAt||0));
  records.push({productId:p.productId,name:p.name||'商品 '+p.productId,bothBlocked,state:bothBlocked?'both-blocked':active?'verifying':singleBlocked?'single-blocked':'waiting',
   category:assignment?.category||(active?'verification':'needs-evidence'),owner:assignment?.owner||'blockers',
   blockedReason:assignment?.blockedReason||null,carePending:assignment?.carePending===true,
   priceReview:latestReview?{id:latestReview.id,key:latestReview.key,status:latestReview.status,expiresAt:latestReview.expiresAt,canConfirm:assignment?.owner==='prices'}:null,
   recheck:request?{id:request.id,state:active?'verifying':requestsPaused?'paused':request.state==='deferred'?'blocked':'queued',requestedAt:request.requestedAt,updatedAt:request.updatedAt||request.requestedAt,message:check?.at>=request.requestedAt?check.message:request.reason||'正在等待后台核验'}:null,
   updatedAt,schemes,pricingDeferred:originalPricesOnly&&pendingReview,code:check?.code||(assignment?.carePending?'CARE_RECOVERY_PENDING':null),message:assignment?.carePending?(assignment.blockedReason+(check?.message?' 最近核验：'+check.message:'')):originalPricesOnly&&pendingReview?'原折扣价受限，已转入恢复受阻；不会自动采用新价格。'+(check?.message||''):check?.message||(active?'已有任务正在核验，结果明确前不重复创建':pendingReview?(originalPricesOnly?'原折扣价受限，已转入恢复受阻；不会自动采用新价格':'存在待确认价格方案'):'等待重新核验'),pendingReview,
   note:careEnabled?'优先恢复原折扣价；本类型依据完整且全部规格不降价时自动调整，任何规格降价仍须你确认。':originalPricesOnly?'本店只按已保存或已确认的原折扣价恢复；需要新价格、规格或活动规则变化时保留受阻原因，不自动改价。':bothBlocked?'同一历史与逐规格价格方案的两次平台拒绝已分别记录；新价格仍须确认，当前状态需再次核验。':'另一方案未核验或证据已变化时，不能认定两种方案都失败。'});
 }
 records.sort((a,b)=>Number(b.bothBlocked)-Number(a.bothBlocked)||b.updatedAt-a.updatedAt||a.productId.localeCompare(b.productId));
 const counts={total:records.length,verification:records.filter(r=>r.category==='verification').length,processing:records.filter(r=>r.category==='processing').length,readBlocked:records.filter(r=>r.category==='read-blocked').length,needsEvidence:records.filter(r=>['needs-evidence','declined'].includes(r.category)).length,bothBlocked:records.filter(r=>r.bothBlocked).length,singleBlocked:records.filter(r=>r.state==='single-blocked').length,waiting:records.filter(r=>['waiting','verifying'].includes(r.state)).length};
 const needle=query.trim().toLocaleLowerCase(),selected=records.filter(r=>(filter==='all'||filter==='both'&&r.bothBlocked||filter==='other'&&!r.bothBlocked)&&(!needle||(r.name+' '+r.productId).toLocaleLowerCase().includes(needle)));
 const size=Math.min(20,Math.max(1,Number.isSafeInteger(Number(pageSize))?Number(pageSize):10)),pages=Math.max(1,Math.ceil(selected.length/size)),current=Math.max(0,Math.min(pages-1,Number.isSafeInteger(Number(page))?Number(page):0));
 return{shopId,counts,total:selected.length,page:current,pageSize:size,pages,filter,records:selected.slice(current*size,(current+1)*size)};
}
