import {fingerprint} from './policy.mjs';

const active=c=>['进行中','未开始'].includes(c.status);
const fresh=(at,now)=>Number.isFinite(at)&&at>0&&now-at>=-5000&&now-at<=5*60000;
const skuRows=skus=>(skus||[]).map(s=>({id:String(s.id||''),name:String(s.name||''),
 baseFen:Number.isSafeInteger(s.baseFen)?s.baseFen:null,discount:Number.isSafeInteger(s.discount)?s.discount:null,
 saleFen:Number.isSafeInteger(s.saleFen)?s.saleFen:null,saleSource:s.saleSource||'historical'}));

// A display snapshot only. Neither the planner nor any write path loads this
// key; execution continues to require fresh platform observations.
export function catalogObservation(shopId,inventory){
 if(!inventory?.listing)return null;
 const campaigns=inventory.listing.campaigns||[],ids=new Set(campaigns.filter(active).map(c=>c.id));
 return{shopId,listing:{complete:inventory.listing.complete,observedAt:inventory.listing.observedAt,campaigns},activeComplete:inventory.activeComplete,
  details:[...inventory.details].filter(([id])=>ids.has(id))};
}
export function buildCatalog({shopId,inventory=null,observation=null,histories=[],tasks=[],excluded=[],now=Date.now()}){
 let restoredObservation=false;
 if(!inventory&&observation?.shopId===shopId&&Array.isArray(observation.details)){
  inventory={...observation,details:new Map(observation.details)};restoredObservation=true;
 }
 const listing=inventory?.listing,complete=listing?.complete===true&&inventory?.activeComplete===true;
 const campaigns=(listing?.campaigns||[]).filter(active),details=inventory?.details||new Map();
 const times=[listing?.observedAt,...campaigns.map(c=>details.get(c.id)?.observedAt)].filter(x=>Number.isFinite(x)&&x>0);
 const observedAt=times.length?Math.min(...times):null,stale=!fresh(observedAt,now);
 const products=new Map(),ensure=(id,name='')=>{
  if(!products.has(id))products.set(id,{productId:id,name,current:[],scheduled:[],removed:[],history:null,pending:false,excluded:excluded.includes(id),ambiguous:false,reason:null,observedAt:null});
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
 for(const id of excluded)ensure(id);
 const scopedTasks=tasks.filter(t=>t.shopId===shopId).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 for(const t of scopedTasks){for(const plan of t.plans||[]){
  const p=ensure(plan.productId,plan.name);
  if(!['verified','blocked'].includes(t.phase)){p.pending=true;p.pendingPhase=t.phase;p.reason=t.reason||'任务结果待核实，程序不会重复提交';}
  else if(t.phase==='blocked'&&!p.reason&&!p.current.length&&!scopedTasks.some(newer=>newer.phase==='verified'&&newer.updatedAt>t.updatedAt&&newer.plans.some(x=>x.productId===plan.productId)))p.reason=t.reason;
 }}
 for(const p of products.values()){
  p.stale=!fresh(p.observedAt||observedAt,now);
  p.state=p.excluded?'excluded':p.pending?'pending':p.ambiguous||stale||!complete?'unconfirmed':p.current.length?'active':p.scheduled.length?'scheduled':p.history?'missing':'unconfirmed';
 }
 const rows=[...products.values()].sort((a,b)=>a.productId.localeCompare(b.productId));
 const counts={products:rows.length,observedCurrentProducts:rows.filter(p=>p.current.length&&!p.stale&&!p.ambiguous).length,
  missingProducts:rows.filter(p=>p.state==='missing').length,pendingProducts:rows.filter(p=>p.pending).length,
  unconfirmedProducts:rows.filter(p=>p.state==='unconfirmed').length,excludedProducts:rows.filter(p=>p.excluded).length,
  historicalProducts:rows.filter(p=>p.history).length};
 const result={shopId,observedAt,listingObservedAt:listing?.observedAt||null,complete,stale,restoredObservation,counts,products:rows};
 return{...result,revision:fingerprint(result)};
}
