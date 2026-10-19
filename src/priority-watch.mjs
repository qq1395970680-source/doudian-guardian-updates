import {fingerprint,requireThat,id} from './policy.mjs';

const active=c=>['进行中','未开始'].includes(c.status);
// This index contains only membership hints, never prices or permission. Every
// hint must go through a new product-scoped platform read before any plan.
export class PriorityWatch {
 constructor(journal,shopId){
  this.journal=journal;this.shopId=id(shopId);this.key='priority-watch:'+shopId;
  const saved=journal.settings(this.key);
  this.records=new Map(saved?.schema===1&&saved.shopId===shopId&&saved.source==='verified-activity-membership'?saved.records:[]);
  // Existing independently verified receipts bootstrap monitoring after an
  // upgrade. Display/diagnostic snapshots are deliberately not consulted.
  for(const task of journal.list(shopId).filter(t=>t.phase==='verified'&&t.receipt?.campaignId))
   for(const plan of task.plans)this.recordOne(plan.productId,task.receipt.campaignId,task.receipt.verifiedAt);
 }
 save(){this.journal.putSettings(this.key,{schema:1,shopId:this.shopId,source:'verified-activity-membership',records:[...this.records]});}
 recordOne(productId,campaignId,observedAt){
  id(productId);id(campaignId);requireThat(Number.isFinite(observedAt)&&observedAt>0,'WATCH_PROOF','活动成员核对时间无效');
  const row=this.records.get(campaignId)||{campaignId,observedAt,products:[]};
  // An older receipt must not undo a later explicit removal observation.
  if(row.observedAt>observedAt)return;
  const products=row.products.filter(p=>p.productId!==productId);products.push({productId,removed:false,ambiguous:false});
  this.records.set(campaignId,{campaignId,observedAt,products});
 }
 observe(campaign,detail){
  requireThat(active(campaign)&&detail?.complete===true&&Number.isFinite(detail.observedAt)&&detail.observedAt>0,'WATCH_PROOF','优先监测只接受独立核对的当前活动');
  id(campaign.id);const products=detail.products.map(p=>({productId:id(p.productId),removed:p.removalConfirmed===true,ambiguous:p.removalAmbiguous===true}));
  requireThat(new Set(products.map(p=>p.productId)).size===products.length,'WATCH_PROOF','活动成员重复');
  // Some removals delete the row entirely. Retain the prior membership as a
  // hint until a new product-scoped query establishes its current state.
  const present=new Set(products.map(p=>p.productId));
  for(const prior of this.records.get(campaign.id)?.products||[])
   if(!present.has(prior.productId))products.push({...prior,absentFromDetail:true});
  this.records.set(campaign.id,{campaignId:campaign.id,observedAt:detail.observedAt,products});this.save();
 }
 hints(listing){
  requireThat(listing?.complete===true,'ACTIVE_UNKNOWN','优先监测的当前活动列表不完整');
  const present=new Set(listing.campaigns.filter(active).map(c=>c.id)),products=new Map();
  for(const row of this.records.values())for(const p of row.products){
   if(!products.has(p.productId))products.set(p.productId,{positive:false,changes:[]});
   const target=products.get(p.productId);
   if(present.has(row.campaignId)&&!p.removed&&!p.ambiguous&&!p.absentFromDetail)target.positive=true;
   else target.changes.push([row.campaignId,p.absentFromDetail?'missing-member':p.removed?'removed':p.ambiguous?'ambiguous':'absent']);
  }
  return [...products].filter(([,p])=>!p.positive&&p.changes.length).map(([productId,p])=>({productId,
   watchKey:fingerprint({shopId:this.shopId,productId,changes:p.changes.sort((a,b)=>a[0].localeCompare(b[0]))})}));
 }
}

export const currentListingKey=listing=>fingerprint(listing.campaigns.filter(active).map(c=>[c.id,c.name,c.type,c.status,c.startAt,c.endAt,c.risk]).sort((a,b)=>a[0].localeCompare(b[0])));
