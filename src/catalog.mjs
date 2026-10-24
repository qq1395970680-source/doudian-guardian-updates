import {fingerprint} from './policy.mjs';

const active=c=>['进行中','未开始'].includes(c.status);
const fresh=(at,now)=>Number.isFinite(at)&&at>0&&now-at>=-5000&&now-at<=5*60000;
const sameCampaign=(a,b)=>!!a&&!!b&&fingerprint([a.id,a.name,a.type,a.status,a.startAt,a.endAt,a.risk===true])===fingerprint([b.id,b.name,b.type,b.status,b.startAt,b.endAt,b.risk===true]);
const skuRows=skus=>(skus||[]).map(s=>({id:String(s.id||''),name:String(s.name||''),
 baseFen:Number.isSafeInteger(s.baseFen)?s.baseFen:null,discount:Number.isSafeInteger(s.discount)?s.discount:null,
 saleFen:Number.isSafeInteger(s.saleFen)?s.saleFen:null,saleSource:s.saleSource||'historical'}));

// A display snapshot only. Neither the planner nor any write path loads this
// key; execution continues to require fresh platform observations.
export function catalogObservation(shopId,inventory,previous=null){
 if(!inventory?.listing)return null;
 const campaigns=inventory.listing.campaigns||[],ids=new Set(campaigns.filter(active).map(c=>c.id));
 const retained=new Map();
 if(previous?.shopId===shopId){
  for(const [id,item] of previous.previousDetails||[])retained.set(id,item);
  for(const [id,detail] of previous.details||[]){const campaign=previous.listing?.campaigns.find(c=>c.id===id);if(campaign)retained.set(id,{campaign,detail});}
 }
 const previousDetails=[...retained].filter(([id,item])=>ids.has(id)&&!inventory.details.has(id)&&item.detail?.complete===true&&sameCampaign(item.campaign,campaigns.find(c=>c.id===id)));
 return{shopId,listing:{complete:inventory.listing.complete,observedAt:inventory.listing.observedAt,currentObservedAt:inventory.listing.currentObservedAt,campaigns},activeComplete:inventory.activeComplete,
  details:[...inventory.details].filter(([id])=>ids.has(id)),previousDetails};
}
export function buildCatalog({shopId,inventory=null,observation=null,histories=[],tasks=[],checks=[],excluded=[],now=Date.now()}){
 let restoredObservation=false;
 if(!inventory&&observation?.shopId===shopId&&Array.isArray(observation.details)){
  inventory={...observation,details:new Map(observation.details)};restoredObservation=true;
 }
 const listing=inventory?.listing,complete=listing?.complete===true&&inventory?.activeComplete===true;
 const campaigns=(listing?.campaigns||[]).filter(active),details=inventory?.details||new Map();
 const listingObservedAt=listing?.currentObservedAt??listing?.observedAt;
 const times=[listingObservedAt,...campaigns.map(c=>details.get(c.id)?.observedAt)].filter(x=>Number.isFinite(x)&&x>0);
 const observedAt=times.length?Math.min(...times):null,stale=!fresh(observedAt,now),listingFresh=listing?.complete===true&&fresh(listingObservedAt,now);
 const products=new Map(),ensure=(id,name='')=>{
  if(!products.has(id))products.set(id,{productId:id,name,current:[],scheduled:[],removed:[],lastObserved:[],history:null,pending:false,excluded:excluded.includes(id),ambiguous:false,reason:null,observedAt:null});
  const p=products.get(id);if(name&&!p.name)p.name=name;return p;
 };
 for(const h of histories.filter(h=>h.shopId===shopId).sort((a,b)=>Number(!!a.generatedByGuardian)-Number(!!b.generatedByGuardian)||(b.historyAt||0)-(a.historyAt||0))){
  const p=ensure(h.productId,h.name);if(!p.history)p.history={campaignId:h.campaignId,historyAt:h.historyAt,observedAt:h.observedAt,skus:skuRows(h.skus)};
 }
 for(const c of campaigns){
  const detail=details.get(c.id);if(detail?.complete!==true)continue;
  for(const member of detail.products||[]){
   const p=ensure(member.productId,member.name);if(member.name)p.name=member.name;
   p.observedAt=p.observedAt?Math.min(p.observedAt,detail.observedAt):detail.observedAt;
   const activity={campaignId:c.id,name:c.name,status:c.status,startAt:c.startAt,endAt:c.endAt,observedAt:detail.observedAt,skus:skuRows(member.skus)};
   if(member.removalConfirmed)p.removed.push(activity);
   else if(member.removalAmbiguous){p.ambiguous=true;p.reason='活动详情的商品状态仍待核实';}
   else if(c.status==='未开始')p.scheduled.push(activity);
   else if(c.endAt&&c.endAt<=now)p.ambiguous=true;
   else p.current.push(activity);
  }
 }
 // Separately retained display values do not populate current/scheduled or
 // observedAt, do not affect completeness, and never authorize a missing item.
 if(observation?.shopId===shopId)for(const [id,item] of observation.previousDetails||[]){
  const c=campaigns.find(c=>c.id===id),detail=item.detail;
  if(details.has(id)||!sameCampaign(c,item.campaign)||detail?.complete!==true||!Number.isFinite(detail.observedAt)||detail.observedAt<=0||detail.observedAt>now+5000)continue;
  for(const member of detail.products||[]){
   if(member.removalConfirmed||member.removalAmbiguous)continue;
   const p=ensure(member.productId,member.name);
   p.lastObserved.push({campaignId:c.id,name:c.name,status:c.status,observedAt:detail.observedAt,skus:skuRows(member.skus)});
  }
 }
 for(const id of excluded)ensure(id);
 const scopedTasks=tasks.filter(t=>t.shopId===shopId).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 for(const t of scopedTasks){for(const plan of t.plans||[]){
  const p=ensure(plan.productId,plan.name);
  if(!['verified','blocked'].includes(t.phase)){p.pending=true;p.pendingPhase=t.phase;p.reason=t.reason||'任务结果待核实，程序不会重复提交';}
  else if(t.phase==='blocked'&&!p.reason&&!p.current.length&&!scopedTasks.some(newer=>newer.phase==='verified'&&newer.updatedAt>t.updatedAt&&newer.plans.some(x=>x.productId===plan.productId)))p.reason=t.reason;
 }}
 for(const p of products.values()){
  p.stale=!fresh(p.observedAt||observedAt,now);
  // A fresh positive observation is useful even while an unrelated activity is
  // loading. Absence still needs complete, fresh coverage of every activity.
  const positiveFresh=listingFresh&&!p.stale&&!p.ambiguous;
  p.state=p.excluded?'excluded':p.pending?'pending':p.ambiguous?'unconfirmed':p.current.length&&positiveFresh?'active':p.scheduled.length&&positiveFresh?'scheduled':stale||!complete?'unconfirmed':p.history?'missing':'unconfirmed';
  const c=checks.find(c=>c.shopId===shopId&&c.productId===p.productId);
  if(c&&!p.current.length&&!p.scheduled.length){
   p.check=c;p.reason=p.reason||c.message;
   if(['PRECHECK_MEMBERSHIP','RESTORE_SKU_BUDGET','RESTORE_PRODUCT_BUDGET','LIMITED_LOSS_UNPROVEN','TIMED_LOSS_UNPROVEN','SKU_RATIO_REVIEW_REQUIRED','PRICE_REVIEW_REQUIRED','REBUILD_REVIEW_REQUIRED'].includes(c.code)&&!p.pending&&!p.excluded)p.recoveryFailure={
    stage:c.code==='PRECHECK_MEMBERSHIP'?'precheck':['LIMITED_LOSS_UNPROVEN','TIMED_LOSS_UNPROVEN'].includes(c.code)?'eligibility':['SKU_RATIO_REVIEW_REQUIRED','PRICE_REVIEW_REQUIRED','REBUILD_REVIEW_REQUIRED'].includes(c.code)?'pricing':'planning',code:c.code,message:c.message,at:c.at,retryAt:c.retryAt||null,
    detail:c.code==='PRECHECK_MEMBERSHIP'?c.precheckMembership||null:null,
    ...(c.code==='PRECHECK_MEMBERSHIP'?{}:{capacity:c.restoreCapacity||null}),
    ...(c.limitedLoss?{limitedLoss:c.limitedLoss}:{}),
    ...(c.timedLoss?{timedLoss:c.timedLoss}:{}),
    submission:'本次恢复检查未通过，尚未进入恢复任务入队和提交'};
   const proof=c.productState,recycled=c.code==='PRODUCT_RECYCLED'&&proof?.kind==='recycled'&&proof.source==='live-platform-product-recycle'&&proof.complete===true&&proof.shopId===shopId&&proof.productId===p.productId;
   if(recycled&&!p.pending&&!p.excluded&&!p.ambiguous){
    const recent=fresh(proof.observedAt,now);p.state=recent?'recycled':'unconfirmed';p.observedAt=proof.observedAt;p.stale=!recent;
    p.reason=recent?c.message:'上次核验商品位于平台回收站，当前状态待更新；历史折扣已保留';
   }
  }
 }
 const rows=[...products.values()].sort((a,b)=>a.productId.localeCompare(b.productId));
 const counts={products:rows.length,observedCurrentProducts:rows.filter(p=>p.current.length&&listingFresh&&!p.stale&&!p.ambiguous).length,
  missingProducts:rows.filter(p=>p.state==='missing').length,pendingProducts:rows.filter(p=>p.pending).length,
  unconfirmedProducts:rows.filter(p=>p.state==='unconfirmed').length,excludedProducts:rows.filter(p=>p.excluded).length,recycledProducts:rows.filter(p=>p.state==='recycled').length,
  recoveryFailedProducts:rows.filter(p=>p.recoveryFailure).length,historicalProducts:rows.filter(p=>p.history).length};
 const result={shopId,observedAt,listingObservedAt:listingObservedAt||null,complete,stale,restoredObservation,counts,products:rows};
 return{...result,revision:fingerprint(result)};
}
