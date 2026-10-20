import {requireThat,restorationGroupKey} from './policy.mjs';

// These are application budgets, not a claim about the platform's limits.
export function recoveryBatches(members,{key=m=>restorationGroupKey(m.baseline),maxProducts=50,maxSkus=500}={}){
 const groups=new Map();
 for(const member of members){const k=key(member);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(member);}
 const batches=[];
 for(const group of groups.values()){
  let batch=[],skus=0;
  for(const member of group){
   const count=member.baseline.skus.length;
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
  // Split only product-specific read failures. Authentication, transport and
  // incomplete evidence fail the batch instead of opening dozens of retries.
  if(members.length>1&&['OFF_SHELF','NOT_FOUND','ALREADY_ACTIVE','PICKER_DISABLED','DUPLICATE_SKU','SKUS_INCOMPLETE','FORM_UNSTABLE','VIRTUAL_LIMIT'].includes(error.code)){
   const middle=Math.ceil(members.length/2);
   return[...await readBatchProducts(platform,members.slice(0,middle)),...await readBatchProducts(platform,members.slice(middle))];
  }
  return members.map(member=>({member,error}));
 }
}
