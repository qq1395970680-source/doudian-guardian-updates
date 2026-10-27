import {id,fingerprint,requireThat} from './policy.mjs';

const active=c=>['进行中','未开始'].includes(c.status);
const fresh=(at,now=Date.now())=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
const sameCampaign=(a,b)=>a&&b&&fingerprint([a.id,a.name,a.type,a.status,a.startAt,a.endAt,a.risk])===
 fingerprint([b.id,b.name,b.type,b.status,b.startAt,b.endAt,b.risk]);
const fatal=e=>['STOPPED','LOGIN_REQUIRED','SHOP_MISMATCH'].includes(e?.code);
function assertListing(listing){
 requireThat(listing?.complete===true&&Array.isArray(listing.campaigns)&&fresh(listing.observedAt)&&
  listing.campaigns.every(active)&&new Set(listing.campaigns.map(c=>c.id)).size===listing.campaigns.length,
  'ACTIVE_UNKNOWN','当前活动列表未完整独立核对');
 for(const c of listing.campaigns)id(c.id);
}

// Historical receipts and cached membership are lookup hints only. Each
// positive result below comes from a new activity detail plus a later current
// status listing; it cannot prove absence, authorize a price or submit a task.
export async function* activeMembershipProofBatches(platform,baselines){
 const shopId=platform.policy.shopId;
 requireThat(baselines.length>0&&baselines.length<=50&&baselines.every(b=>b.shopId===shopId)&&
  new Set(baselines.map(b=>b.productId)).size===baselines.length,'ACTIVE_UNKNOWN','已有活动核对商品集合不一致');
 const targets=new Map(baselines.map(b=>[id(b.productId),b])),pending=new Set(targets.keys());
 const hints=new Map([...targets.keys()].map(productId=>[productId,new Set()]));
 const hint=(productId,campaignId)=>{
  if(!hints.has(productId)||typeof campaignId!=='string')return;
  try{id(campaignId);}catch{return;}hints.get(productId).add(campaignId);
 };
 for(const b of baselines)hint(b.productId,b.campaignId);
 for(const [campaignId,detail] of platform.inventory?.details||[])
  if(detail?.complete===true)for(const p of detail.products||[])hint(p.productId,campaignId);
 for(const task of platform.journal?.list?.(shopId)||[])
  if(task.phase==='verified'&&task.receipt?.campaignId)for(const plan of task.plans)hint(plan.productId,task.receipt.campaignId);
 const watch=platform.journal?.settings?.('priority-watch:'+shopId);
 if(watch?.schema===1&&watch.shopId===shopId&&watch.source==='verified-activity-membership'&&Array.isArray(watch.records))
  for(const [campaignId,row] of watch.records)for(const p of row.products||[])hint(p.productId,campaignId);

 let listing=await platform.listActive();assertListing(listing);
 const candidates=listing.campaigns.filter(c=>[...pending].some(productId=>hints.get(productId).has(c.id)));
 const prove=(campaign,detail,after)=>{
  const current=after.campaigns.find(c=>c.id===campaign.id);
  requireThat(sameCampaign(campaign,current),'ACTIVE_CHANGED','已有活动在核对期间变化，等待重新读取');
  requireThat(detail?.complete===true&&Array.isArray(detail.products)&&
   new Set(detail.products.map(p=>p.productId)).size===detail.products.length,'ACTIVE_UNKNOWN','已有活动商品成员尚未完整核对');
  // The first listing selected the page only. Keep the actual detail time and
  // the later status read; a matching list never renews an old detail timestamp.
  const observedAt=Math.min(detail.observedAt,after.observedAt);
  requireThat(fresh(observedAt),'BATCH_PROOF_EXPIRED','已有活动的独立成员证明已过期');
  return detail.products.filter(p=>pending.has(p.productId)&&!p.removalConfirmed).map(p=>({productId:p.productId,
   loss:{complete:true,active:true,ambiguous:p.removalAmbiguous===true,campaignId:current.id,observedAt}}));
 };
 // These waves limit concurrent read pages, not products restored per round.
 // All requested products continue here; native restoration batches remain 50.
 for(let start=0;start<candidates.length;start+=6){
  platform.check();
  const group=candidates.slice(start,start+6).filter(c=>[...pending].some(productId=>hints.get(productId).has(c.id)));
  if(!group.length)continue;
  const reads=await Promise.allSettled(group.map(c=>platform.detail(c)));
  const stopped=reads.find(r=>r.status==='rejected'&&fatal(r.reason));if(stopped)throw stopped.reason;
  listing=await platform.listActive();assertListing(listing);
  for(let i=0;i<group.length;i++){
   if(reads[i].status!=='fulfilled')continue;
   let proofs;
   try{proofs=prove(group[i],reads[i].value,listing);}
   catch(error){
    if(error.code!=='BATCH_PROOF_EXPIRED')continue;
    // A slow unrelated page may age an early positive read. Re-read only that
    // activity once, then validate it before waiting for another group.
    try{
     const current=listing.campaigns.find(c=>c.id===group[i].id);if(!current)continue;
     const detail=await platform.detail(current),after=await platform.listActive();assertListing(after);
     proofs=prove(current,detail,after);listing=after;
    }catch(retryError){if(fatal(retryError))throw retryError;continue;}
   }
   if(!proofs.length)continue;
   for(const proof of proofs)pending.delete(proof.productId);
   platform.journal?.event?.(null,'active-membership-proof-batch',{shopId,campaignId:group[i].id,
    productIds:proofs.map(p=>p.productId),observedAt:Math.min(...proofs.map(p=>p.loss.observedAt)),source:'independent-current-activity-detail'},Date.now());
   yield proofs;
  }
 }
 // No matching known source means another fresh, product-scoped query is
 // required. It never becomes an absence or an automatic restoration here.
 const remaining=[...pending].map(productId=>targets.get(productId));
 for(let start=0;start<remaining.length;start+=6){
  platform.check();const group=remaining.slice(start,start+6);
  const results=await platform.lossBatch(group);
  requireThat(results.length===group.length&&new Set(results.map(r=>r.productId)).size===group.length&&
   results.every(r=>group.some(b=>b.productId===r.productId)),'ACTIVE_UNKNOWN','已有活动的后备核对商品集合不一致');
  for(const result of results){
   if(fatal(result.error))throw result.error;
   if(result.error?.code==='BATCH_PROOF_EXPIRED'||result.loss&&!fresh(result.loss.observedAt)){
    const retry=await platform.lossBatch([targets.get(result.productId)]);
    requireThat(retry.length===1&&retry[0].productId===result.productId,'ACTIVE_UNKNOWN','已有活动的单件重读商品不一致');
    yield retry;
   }else yield[result];
  }
 }
}
