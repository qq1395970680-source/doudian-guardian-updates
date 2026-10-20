import {fingerprint,requireThat,validateHistorical,isLimited,restorationGroupKey,normalizeName} from './policy.mjs';
import {setCampaignPolicy,campaignPolicy} from './campaign-policy.mjs';

const active=c=>['进行中','未开始'].includes(c.status);
const importable=b=>{
 requireThat(b.skus.every(s=>s.discount>=10&&s.discount<=95),'TEMPLATE_RANGE','现有折扣超出已验证导入范围，原活动尚未作废');
 requireThat(new Set(b.skus.map(s=>normalizeName(s.name))).size===b.skus.length,'DUPLICATE_SKU','同名规格不能唯一回读，原活动尚未作废');
};
export const conversionKey=shopId=>'campaign-conversion:'+shopId;
const cancellationConfirmationLimit=(state,entry)=>{
 const grant=entry.retryAuthorization;
 return grant?.source==='human-request'&&grant.confirmed===true&&grant.shopId===state.shopId&&
  grant.campaignId===entry.campaign.id&&grant.material===entry.material&&grant.priorConfirmAttempts===1&&
  grant.maxConfirmAttempts===2&&fingerprint(grant.productIds)===fingerprint([...entry.productIds].sort())?2:1;
};
export function conversionGroups(journal,shopId,baselines,productIds){
 const groups=new Map(),policy=campaignPolicy(journal,shopId);
 for(const productId of productIds){
  const baseline=baselines.get(productId),review=journal.priceTarget(shopId,productId);
  requireThat(baseline,'CONVERSION_CHANGED','迁移历史缺失');
  const approved=review?.status==='approved'&&review.historicalFingerprint===fingerprint(baseline);
  const skus=baseline.skus.map(s=>({discount:approved?review.rows.find(r=>r.id===s.id)?.discount??s.discount:s.discount}));
  const key=restorationGroupKey({...baseline,...policy?.target,skus});
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(productId);
 }
 return [...groups.values()];
}
export function campaignMaterial(c,d){
 return fingerprint({id:c.id,name:c.name,type:c.type,startAt:c.startAt,endAt:c.endAt,rules:d.rules,
  products:[...d.products].map(p=>({productId:p.productId,activityLimit:p.activityLimit,
   removalConfirmed:!!p.removalConfirmed,removalAmbiguous:!!p.removalAmbiguous,
   skus:[...p.skus].map(s=>({id:s.id,name:s.name,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.productId.localeCompare(b.productId))});
}
export class CampaignConversion{
 constructor(service){this.service=service;this.journal=service.journal;this.platform=service.platform;this.shopId=service.policy.shopId;}
 state(){return this.journal.settings(conversionKey(this.shopId));}
 save(state){state.updatedAt=Date.now();this.journal.putSettings(conversionKey(this.shopId),state);return state;}
 idle(){
  requireThat(!this.service.running&&!this.service.busy,'BUSY','请先暂停守护，迁移不能与巡检重叠');
  requireThat(!this.journal.list(this.shopId).some(t=>['submitting','unknown','verifying'].includes(t.phase)),'CONVERSION_UNKNOWN','已有未知提交必须先回读');
 }
 async capture(target,consent){
  this.idle();requireThat(!this.state(),'CONVERSION_EXISTS','已有持久迁移记录，请从记录继续');
  const identity=await this.platform.probe();requireThat(identity.shopId===this.shopId,'SHOP_MISMATCH','迁移店铺不一致');
  const listing=await this.platform.listActive();requireThat(listing.complete===true,'ACTIVE_UNKNOWN','当前活动未完整读取');
  const captureKey='campaign-conversion-capture:'+this.shopId,prior=this.journal.settings(captureKey);
  const checkpoint=prior?.requestId===consent.requestId&&prior.shopId===this.shopId&&prior.source==='direct-platform-conversion-read'?prior:
   {schema:1,requestId:consent.requestId,shopId:this.shopId,source:'direct-platform-conversion-read',details:{}};
  let count=0;const details=new Map();
  for(let start=0;start<listing.campaigns.length;start+=2){
   const reads=await Promise.allSettled(listing.campaigns.slice(start,start+2).map(async c=>{
    const prior=checkpoint.details[c.id],now=Date.now();
    let d=prior?.key===fingerprint(c)&&prior.detail.complete===true&&prior.detail.observedAt<=now+5000&&now-prior.detail.observedAt<=30*60000?prior.detail:null;
    if(!d)d=await this.platform.detail(c);
    requireThat(d.complete===true,'DETAIL_INCOMPLETE','迁移前规格未完整读取');
    details.set(c.id,d);checkpoint.details[c.id]={key:fingerprint(c),detail:d};this.journal.putSettings(captureKey,checkpoint);
    this.platform.progress={stage:'保存迁移前完整活动',read:++count,total:listing.campaigns.length,at:Date.now()};
   }));
   const error=reads.find(r=>r.status==='rejected');if(error)throw error.reason;
  }
  const campaigns=[],products=new Map();
  for(const c of listing.campaigns){
   requireThat(active(c),'CONVERSION_CHANGED','迁移列表包含非当前活动');
   const d=details.get(c.id);requireThat(d.complete===true,'DETAIL_INCOMPLETE','迁移前规格未完整读取');
   const members=[];
   for(const p of d.products){
    requireThat(!p.removalAmbiguous,'CONVERSION_CHANGED','当前商品存在不明确的部分规格退出，先核实');
    const b={source:'verified-platform-history',complete:true,shopId:this.shopId,productId:p.productId,name:p.name,campaignId:c.id,
     historyAt:c.startAt,generatedByGuardian:c.name.startsWith('守护2-'),observedAt:d.observedAt,type:c.type,rules:d.rules,skus:p.skus,
     ...(isLimited(c)?{activityLimit:p.activityLimit,durationMs:c.endAt-c.startAt}:{})};
    validateHistorical(b);this.journal.remember(b);members.push(p.productId);
    if(this.service.policy.excludedProductIds?.includes(p.productId))continue;
    importable(b);
    const prior=products.get(p.productId);
    requireThat(!prior||prior.removed||p.removalConfirmed,'CONVERSION_DUPLICATE','商品存在多个有效活动，不能确定应保留的折扣');
    if(!prior||prior.removed&&!p.removalConfirmed||prior.removed===!!p.removalConfirmed&&b.historyAt>prior.baseline.historyAt)
     products.set(p.productId,{baseline:b,removed:!!p.removalConfirmed});
   }
   campaigns.push({campaign:structuredClone(c),material:campaignMaterial(c,d),productIds:members,phase:'captured',cancelAttempts:0,confirmAttempts:0});
  }
  requireThat(products.size>0,'CONVERSION_EMPTY','当前没有可迁移商品');
  const baselines=[...products.values()].map(p=>p.baseline);
  const policy=setCampaignPolicy(this.journal,this.shopId,target,baselines,consent);
  return this.save({schema:1,shopId:this.shopId,requestId:consent.requestId,source:'live-platform-conversion',status:'captured',
   target:structuredClone(target),createdAt:Date.now(),campaigns,products:baselines.map(b=>({productId:b.productId,baselineFingerprint:policy.preferredBaselines[b.productId],sourceCampaignId:b.campaignId,phase:'pending'}))});
 }
 authorizeCancellationRetry(campaignId,consent){
  this.idle();const state=this.state(),entry=state?.campaigns.find(e=>e.campaign.id===campaignId);
  requireThat(entry&&entry.phase!=='cancelled'&&entry.confirmAttempts===1&&!entry.retryAuthorization&&
   consent?.confirmed===true&&consent.source==='human-request'&&typeof consent.requestId==='string'&&consent.requestId.length>0&&
   consent.shopId===this.shopId&&consent.campaignId===campaignId&&Array.isArray(consent.productIds)&&
   fingerprint([...consent.productIds].sort())===fingerprint([...entry.productIds].sort()),
   'CONVERSION_CONSENT','再次作废须有本人针对该店铺、活动及全部商品的一次明确授权');
  entry.retryAuthorization={source:'human-request',confirmed:true,requestId:consent.requestId,shopId:this.shopId,campaignId,
   productIds:[...entry.productIds].sort(),material:entry.material,priorConfirmAttempts:entry.confirmAttempts,
   maxConfirmAttempts:2,authorizedAt:Date.now()};
  this.save(state);this.journal.event(null,'conversion-cancel-retry-authorized',{...entry.retryAuthorization},Date.now());
  return entry;
 }
 async cancel(campaignId){
  this.idle();const state=this.state(),entry=state?.campaigns.find(e=>e.campaign.id===campaignId);
  requireThat(entry,'CONVERSION_SCOPE','活动不在已备份迁移清单中');
  if(entry.phase==='cancelled')return entry;
  const baselines=this.service.latestHistories();
  for(const item of state.products.filter(p=>entry.productIds.includes(p.productId))){
   const b=baselines.get(item.productId);
   requireThat(b&&fingerprint(b)===item.baselineFingerprint,'CONVERSION_CHANGED','迁移来源发生变化，原活动尚未作废');importable(b);
  }
  const listing=await this.platform.list({title:entry.campaign.name});
  requireThat(listing.complete===true,'ACTIVE_UNKNOWN','作废结果尚未完整读取');
  const c=listing.campaigns.find(c=>c.id===campaignId);
  requireThat(c,'CONVERSION_UNKNOWN','找不到原活动，不能猜测已作废');
  if(!active(c)){
   requireThat(['已作废','已失效','已结束'].includes(c.status),'CONVERSION_UNKNOWN','活动状态未知');
   entry.phase='cancelled';entry.endedStatus=c.status;entry.cancelledAt=Date.now();this.save(state);return entry;
  }
  const confirmationLimit=cancellationConfirmationLimit(state,entry);
  requireThat(entry.confirmAttempts<confirmationLimit&&entry.cancelAttempts<3,'CONVERSION_UNKNOWN','此前已确认作废或入口重试次数已到上限，继续只读核实');
  const d=await this.platform.detail(c);
  requireThat(d.complete===true&&campaignMaterial(c,d)===entry.material,'CONVERSION_CHANGED','原活动商品、折扣或规则已变化，未作废');
  try{
   await this.platform.cancelCampaign(c,async stage=>{
    if(stage==='intent'){requireThat(entry.confirmAttempts<confirmationLimit&&entry.cancelAttempts<3,'CONVERSION_UNKNOWN','重复作废被阻止');entry.cancelAttempts++;entry.phase='cancelling';}
    else if(stage==='confirm'){requireThat(entry.cancelAttempts>0&&entry.confirmAttempts<confirmationLimit,'CONVERSION_UNKNOWN','重复作废确认被阻止');entry.confirmAttempts++;}
    else throw Error('Unknown cancellation boundary');
    this.save(state);this.journal.event(null,'conversion-cancel-'+stage,{shopId:this.shopId,campaignId},Date.now());
   });
  }catch(error){entry.phase=entry.confirmAttempts>0?'cancel-unknown':'cancel-unconfirmed';entry.error=String(error.message).slice(0,1000);entry.errorCode=error.code||'ERROR';this.save(state);throw error;}
  return this.cancel(campaignId);
 }
 async absence(product){
  const listing=await this.platform.list({productId:product.productId});
  requireThat(listing.complete===true,'ACTIVE_UNKNOWN','迁移商品的当前活动未完整读取');
  for(const c of listing.campaigns.filter(active)){
   const d=await this.platform.detail(c);requireThat(d.complete,'ACTIVE_UNKNOWN','当前活动规格未完整读取');
   const p=d.products.find(p=>p.productId===product.productId);
   requireThat(!p||p.removalConfirmed&&!p.removalAmbiguous,'ALREADY_ACTIVE','迁移商品仍有有效活动，未重复创建');
  }
  return{complete:true,observedAt:Date.now(),lossKey:fingerprint({conversion:this.state().requestId,productId:product.productId,campaigns:listing.campaigns.map(c=>[c.id,c.status,c.startAt,c.endAt]).sort()})};
 }
 async restore(productIds,{allowPriceFollowup=true}={}){
  this.idle();const state=this.state(),items=state?.products.filter(p=>productIds.includes(p.productId)&&p.phase!=='verified');
  requireThat(items?.length&&items.length<=5,'CONVERSION_SCOPE','每批迁移1至5件商品');
  const plans=[],proofs=[],latest=this.service.latestHistories();
  for(const item of items){
   requireThat(state.campaigns.filter(c=>c.productIds.includes(item.productId)).every(c=>c.phase==='cancelled'),
    'CONVERSION_ACTIVE','原活动尚未确认作废，不能创建');
   const pending=this.journal.list(this.shopId).find(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===item.productId));
   requireThat(!pending,'CONVERSION_UNKNOWN','该商品仍有未完成任务');
   const already=this.journal.list(this.shopId).find(t=>t.phase==='verified'&&t.createdAt>=state.createdAt&&t.plans.some(p=>p.productId===item.productId));
   if(already){item.phase='verified';item.taskId=already.id;item.receipt=already.receipt;continue;}
   const baseline=latest.get(item.productId);
   requireThat(baseline&&fingerprint(baseline)===item.baselineFingerprint,'CONVERSION_CHANGED','迁移价格来源变化，先核实');
   proofs.push(await this.absence(item));
   try{const current=await this.platform.precheck(baseline);plans.push(this.service.restorePlan(baseline,current));}
   catch(error){
    if(!['OFF_SHELF','PRODUCT_RECYCLED'].includes(error.code))throw error;
    item.phase='skipped';item.reason=error.code;this.save(state);
   }
  }
  if(!plans.length){this.save(state);return null;}
  requireThat(plans.every(p=>restorationGroupKey(p)===restorationGroupKey(plans[0])),'CONVERSION_GROUP','同批商品必须属于相同折扣组');
  requireThat(plans.every(p=>Date.now()-p.observedAt<=120000)&&proofs.every(p=>Date.now()-p.observedAt<=120000),'PROOF_EXPIRED','本批预查已过期');
  const proof={complete:true,observedAt:Math.min(...proofs.map(p=>p.observedAt)),lossKey:fingerprint(proofs.map(p=>p.lossKey))};
  let task=this.journal.enqueue(this.shopId,plans,proof);
  if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=Date.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence:proof,reason:null});
  for(const item of items.filter(i=>plans.some(p=>p.productId===i.productId))){item.phase='restoring';item.taskId=task.id;}
  this.save(state);
  if(task.phase==='queued')await this.service.execute(task);
  task=this.journal.get(task.id);
  if(task.phase==='verified')for(const item of items.filter(i=>i.taskId===task.id)){item.phase='verified';item.receipt=task.receipt;}
  this.save(state);
  if(allowPriceFollowup&&task.phase==='blocked'&&task.submitAttempts===0&&
   plans.some(p=>this.service.priceIncreaseFollowups.has(p.productId))){
   const ids=plans.map(p=>p.productId);for(const id of ids)this.service.priceIncreaseFollowups.delete(id);
   for(const group of conversionGroups(this.journal,this.shopId,this.service.latestHistories(),ids)){
    task=await this.restore(group,{allowPriceFollowup:false});
    if(task&&task.phase!=='verified')break;
   }
  }
  return task;
 }
 async finish(){
  this.idle();const state=this.state();
  requireThat(state&&state.campaigns.every(c=>c.phase==='cancelled')&&state.products.every(p=>['verified','skipped'].includes(p.phase)),
   'CONVERSION_INCOMPLETE','迁移尚有未完成商品');
  const tasks=[...new Set(state.products.filter(p=>p.phase==='verified').map(p=>p.taskId))];
  for(const id of tasks){
   const task=this.journal.get(id),readback=await this.platform.readback(task);
   requireThat(readback,'CONVERSION_INCOMPLETE','迁移活动仍待最终回读');
   const {proveReadback}=await import('./policy.mjs');proveReadback(task.plans,readback,{title:task.title});
  }
  state.status='complete';state.completedAt=Date.now();this.save(state);return state;
 }
}
