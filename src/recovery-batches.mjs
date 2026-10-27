import {requireThat,restorationGroupKey} from './policy.mjs';
import {RECOVERY_MAX_PRODUCTS,RECOVERY_MAX_SKUS} from './recovery-capacity.mjs';

// These are application budgets, not a claim about the platform's limits.
export function recoveryBatches(members,{key=m=>restorationGroupKey(m.baseline),maxProducts=RECOVERY_MAX_PRODUCTS,maxSkus=RECOVERY_MAX_SKUS}={}){
 const groups=new Map();
 for(const member of members){const k=key(member);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(member);}
 const batches=[];
 for(const group of groups.values()){
  let batch=[],skus=0;
  for(const member of group){
   // Historical oversized products get an independent read first. Once the
   // current plan exists, restorePlan/Journal enforce hard execution bounds;
   // never truncate history to manufacture a batch under the budget.
   const count=(member.plan||member.baseline).skus.length;
   if(batch.length&&(batch.length>=maxProducts||skus+count>maxSkus)){batches.push(batch);batch=[];skus=0;}
   batch.push(member);skus+=count;
  }
  if(batch.length)batches.push(batch);
 }
 return batches;
}

export async function readBatchProducts(platform,members){
 if(!members.length)return[];
 try{
  const values=members.length===1?[await platform.precheck(members[0].baseline)]:
   await platform.precheckBatch(members.map(m=>m.baseline));
  requireThat(values.length===members.length&&new Set(values.map(v=>v.productId)).size===members.length&&
   values.every(v=>members.some(m=>m.baseline.productId===v.productId)),'PRECHECK_MEMBERSHIP','批量预查返回商品集合不一致');
  return members.map(member=>({member,current:values.find(v=>v.productId===member.baseline.productId)}));
 }catch(error){
  if(error.code==='STOPPED')throw error;
  if(error.code==='PRECHECK_ACTIVE_HINTS'){
   try{
    const data=error.detail?.activePicker,now=Date.now(),ids=new Set(members.map(m=>m.baseline.productId));
    const fresh=at=>Number.isFinite(at)&&at>0&&now-at>=-5000&&now-at<=120000;
    requireThat(data?.source==='live-platform-activity-picker'&&data.complete===true&&
     typeof data.shopId==='string'&&members.every(m=>m.baseline.shopId===data.shopId)&&fresh(data.observedAt)&&
     Array.isArray(data.targetProductIds)&&data.targetProductIds.length===members.length&&
     new Set(data.targetProductIds).size===members.length&&data.targetProductIds.every(productId=>ids.has(productId))&&
     Array.isArray(data.rows)&&data.rows.length===members.length&&new Set(data.rows.map(r=>r.productId)).size===members.length&&
     data.rows.every(r=>ids.has(r.productId)&&['active_hint','selectable'].includes(r.status)&&fresh(r.observedAt))&&
     data.rows.some(r=>r.status==='active_hint'),'PRECHECK_MEMBERSHIP','批量选品提示的店铺、商品集合或读取时间尚未完整核对');
    const hinted=new Set(data.rows.filter(r=>r.status==='active_hint').map(r=>r.productId));
    const eligible=members.filter(m=>!hinted.has(m.baseline.productId));
    // Selectable rows still need their own complete current SKU precheck.
    // An active hint only enters recoverBatch's independent activity reader.
    const remaining=await readBatchProducts(platform,eligible);
    requireThat(remaining.length===eligible.length&&new Set(remaining.map(row=>row.member.baseline.productId)).size===eligible.length&&
     remaining.every(row=>eligible.some(member=>member.baseline.productId===row.member.baseline.productId)),
     'PRECHECK_MEMBERSHIP','批量选品提示后，完整规格预查的商品集合不一致');
    const byProduct=new Map(remaining.map(row=>[row.member.baseline.productId,row]));
    return members.map(member=>hinted.has(member.baseline.productId)?{member,
     error:Object.assign(new Error('选品提示已有活动，等待独立活动核对'),{code:'ALREADY_ACTIVE'})}:
     byProduct.get(member.baseline.productId));
   }catch(scopeError){
    if(scopeError.code==='STOPPED')throw scopeError;
    return members.map(member=>({member,error:scopeError}));
   }
  }
  // Split only product-specific read failures. Authentication, transport and
  // incomplete evidence fail the batch instead of opening dozens of retries.
  if(members.length>1&&['OFF_SHELF','NOT_FOUND','ALREADY_ACTIVE','PICKER_DISABLED','DUPLICATE_SKU','SKUS_INCOMPLETE','FORM_UNSTABLE','VIRTUAL_LIMIT'].includes(error.code)){
   const middle=Math.ceil(members.length/2);
   return[...await readBatchProducts(platform,members.slice(0,middle)),...await readBatchProducts(platform,members.slice(middle))];
  }
  return members.map(member=>({member,error}));
 }
}
