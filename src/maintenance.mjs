import {GuardianService} from './service.mjs';
import {DoudianPlatform} from './platform.mjs';
import {Journal} from './journal.mjs';
import {requireThat} from './policy.mjs';

// Bounded maintenance for an already-retained native confirmation page. This
// never runs discovery, prepares a draft, uploads prices, or repeats main submit.
export async function continueRetainedRisks(service,{candidateBuild}={}){
 requireThat(!service.running&&!service.busy&&service.stopRequested,'BUSY','只能在后台停止且空闲时续接原确认页');
 requireThat(service.policy.liveEnabled&&service.policy.cutoverConfirmed,'CUTOVER_REQUIRED','尚未完成执行权交接');
 requireThat(/^[a-f0-9]{64}$/.test(candidateBuild||''),'BUILD_REQUIRED','维护模块构建标识缺失');
 const source=service.platform,journal=Object.create(service.journal);
 // Keep the live database connection and page ownership; only the validated
 // risk-proof implementation changes for this bounded operation.
 journal.beginRiskConfirmation=(...args)=>Journal.prototype.beginRiskConfirmation.apply(service.journal,args);
 const platform=new DoudianPlatform({browser:source.browser,policy:service.policy,journal,base:source.base});
 platform.drafts=source.drafts;
 Object.defineProperty(platform,'progress',{get:()=>source.progress,set:value=>{source.progress=value;},configurable:true});
 const runner=new GuardianService({journal,platform,policy:service.policy});
 const check=platform.check.bind(platform);
 platform.check=()=>{requireThat(!service.stopRequested,'STOPPED','原确认页续接已停止');check();};
 const assertWrite=platform.assertWrite;
 platform.assertWrite=()=>{platform.check();assertWrite();};
 const tasks=journal.list(service.policy.shopId).filter(task=>['unknown','verifying'].includes(task.phase));
 const results=[];let heartbeat;
 service.busy=true;service.stopRequested=false;
 try{
  journal.lease(service.policy.shopId,runner.owner);
  heartbeat=setInterval(()=>{try{journal.lease(service.policy.shopId,runner.owner);}catch{service.stopRequested=true;}},20000);
  journal.event(null,'retained-risk-maintenance-start',{candidateBuild,tasks:tasks.map(task=>task.id)});
  for(const task of tasks){
   platform.check();
   try{const verified=await runner.reconcile(task);results.push({taskId:task.id,verified,phase:journal.get(task.id).phase});}
   catch(error){
    journal.event(task.id,'verification-pending',{code:error.code||'ERROR',message:error.message});
    await platform.captureFailure(task,null,'verifying',error).catch(()=>{});
    results.push({taskId:task.id,verified:false,phase:journal.get(task.id).phase,code:error.code||'ERROR',message:error.message});
   }
  }
  journal.event(null,'retained-risk-maintenance-complete',{candidateBuild,results});return results;
 }finally{
  clearInterval(heartbeat);runner.stop();journal.release(service.policy.shopId,runner.owner);
  service.stopRequested=true;service.busy=false;source.stopping=true;
 }
}
