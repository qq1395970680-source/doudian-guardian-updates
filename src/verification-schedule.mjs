import {randomUUID} from 'node:crypto';
import {fingerprint,id} from './policy.mjs';
const key=shop=>'verification-schedule:'+id(shop),signature=task=>fingerprint({id:task.id,phase:task.phase,updatedAt:task.updatedAt});
const load=(journal,shop)=>journal.settings(key(shop))||{schema:1,shopId:shop,entries:{}};
export function verificationState(journal,shop,task){const entry=load(journal,shop).entries[task.id];return entry?.signature===signature(task)?entry:null;}
export function dueVerificationTasks(journal,shop,tasks,now=Date.now()){
 const data=load(journal,shop);return tasks.filter(task=>['unknown','verifying'].includes(task.phase)).filter(task=>{const entry=data.entries[task.id];return !entry||entry.signature!==signature(task)||entry.nextAt<=now;}).sort((a,b)=>(data.entries[a.id]?.lastAttemptAt||0)-(data.entries[b.id]?.lastAttemptAt||0)||a.updatedAt-b.updatedAt);
}
export function claimVerification(journal,shop,task,now=Date.now()){
 const data=load(journal,shop),previous=data.entries[task.id],same=previous?.signature===signature(task);
 if(same&&previous.nextAt>now)return null;
 const entry={taskId:task.id,signature:signature(task),attempts:(same?previous.attempts:0)+1,lastAttemptAt:now,nextAt:now+30000,token:randomUUID()};
 data.entries[task.id]=entry;journal.putSettings(key(shop),data);return entry;
}
export function finishVerification(journal,shop,claim,{resolved=false,error=null}={},now=Date.now()){
 const data=load(journal,shop),entry=data.entries[claim.taskId];if(entry?.token!==claim.token)return;
 if(resolved)delete data.entries[claim.taskId];else Object.assign(entry,{lastFinishedAt:now,nextAt:now+Math.min(900000,30000*2**Math.min(5,Math.max(0,entry.attempts-1))),lastError:error?.code||null});
 const unresolved=new Set(journal.list(shop).filter(t=>['unknown','verifying'].includes(t.phase)).map(t=>t.id));for(const taskId of Object.keys(data.entries))if(!unresolved.has(taskId))delete data.entries[taskId];
 journal.putSettings(key(shop),data);
}
export function wakeVerification(journal,shop,taskIds,now=Date.now()){
 const data=load(journal,shop);let changed=false;for(const taskId of taskIds)if(data.entries[taskId]){data.entries[taskId].nextAt=now;changed=true;}
 if(changed)journal.putSettings(key(shop),data);
}
export function verificationSummary(journal,shop){
 if(!shop)return{pending:0,nextAt:null};const entries=Object.values(load(journal,shop).entries);
 return{pending:entries.length,nextAt:entries.length?Math.min(...entries.map(e=>e.nextAt)):null,entries:entries.map(e=>({taskId:e.taskId,attempts:e.attempts,nextAt:e.nextAt,lastAttemptAt:e.lastAttemptAt,lastError:e.lastError||null}))};
}
