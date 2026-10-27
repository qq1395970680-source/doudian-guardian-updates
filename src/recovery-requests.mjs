import {id,requireThat} from './policy.mjs';
import {randomUUID} from 'node:crypto';
const key=shopId=>'priority-recovery:'+id(shopId);
export const recoveryRequests=(journal,shopId)=>journal.settings(key(shopId))||{schema:1,paused:false,items:[]};
export function requestRecovery(journal,shopId,products,reason,now=Date.now(),{transaction=true}={}){
 const run=()=>{
  const saved=recoveryRequests(journal,shopId);
  for(const product of products){
   const previous=saved.items.find(r=>r.productId===product.productId)||(saved.recent||[]).find(r=>r.productId===product.productId);
   id(product.productId);const request={id:randomUUID(),productId:product.productId,approvalId:product.approvalId||null,
    sourceReviewId:product.approvalId||previous?.sourceReviewId||previous?.approvalId||null,
    requestedAt:now,retryAt:now,requestReason:reason,reason,state:'pending'};
   saved.items=saved.items.filter(r=>r.productId!==request.productId);saved.items.push(request);
   saved.recent=(saved.recent||[]).filter(r=>r.productId!==request.productId);
   journal.event(null,'priority-recovery-requested',{shopId,...request},now);
  }
  requireThat(saved.items.length<=10000,'RECOVERY_QUEUE_CAPACITY','优先恢复队列已满，现有请求保留');
  saved.paused=false;journal.putSettings(key(shopId),saved);return saved.items;
 };return transaction?journal.transaction(run):run();
}
export function updateRecoveryRequest(journal,shopId,request,patch,now=Date.now()){
 const saved=recoveryRequests(journal,shopId),index=saved.items.findIndex(r=>r.id===request.id);
 if(index<0)return;
 const current=saved.items[index],updated={...current,...patch,requestReason:current.requestReason||current.reason,updatedAt:now};
 if(patch.state==='complete'){
  saved.items.splice(index,1);
  // Keep the latest conclusion after draining the execution queue. This is
  // display history only; it cannot grant consent or recreate a task.
  saved.recent=[...(saved.recent||[]).filter(r=>r.productId!==current.productId),{...updated,completedAt:now}].slice(-10000);
 }else saved.items[index]=updated;
 journal.putSettings(key(shopId),saved);
 journal.event(null,'priority-recovery-'+patch.state,{shopId,productId:request.productId,requestId:request.id,...patch},now);
}
export function pauseRecoveryRequests(journal,shopId,paused){
 if(!shopId)return;const saved=recoveryRequests(journal,shopId);saved.paused=paused;journal.putSettings(key(shopId),saved);
}
