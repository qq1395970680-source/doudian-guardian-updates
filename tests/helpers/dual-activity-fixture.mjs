import {randomUUID} from 'node:crypto';
import {careServiceFixture} from './care-service-fixture.mjs';
import {setDualActivityCarePolicy,activeDualActivityCareGrant,dualProbePlan,makeDualActivityDecision} from '../../src/dual-activity-recovery.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';

// Real create-form prechecks have no SKU ID. The planner must bind the trusted
// unique name/base rows back to complete historical IDs before dry imports.
export function dualActivityFixture(journal,{now=Date.now(),caps={},floors={},readFailures=[],dropReadback=false,nullIds=true}={}){
 const f=careServiceFixture(journal,{now,dropReadback});setDualActivityCarePolicy(journal,f.policy.shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},now);
 f.state.dualReads=[];f.state.prepares=[];f.state.caps=caps;f.state.floors=floors;
 const originalPrecheck=f.platform.precheck;f.platform.precheck=async b=>{const c=await originalPrecheck(b);c.offShelf=false;if(nullIds)c.skus=c.skus.map(s=>({...s,id:null,idSource:'unavailable-in-create-form'}));return c;};
 f.state.floorFen=0;
 f.platform.priceCheck=async task=>{
  f.state.dualReads.push(task.plans[0].type);
  if(readFailures.includes(task.plans[0].type))throw Object.assign(new Error('fixture independent draft read timeout'),{code:'READ_OPERATION_TIMEOUT'});
  return dualDraftObservation(task,{now:f.now(),capFen:f.state.caps[task.plans[0].type],floorFen:f.state.floors[task.plans[0].type]});
 };
 const prepare=f.platform.prepare;f.platform.prepare=async task=>{f.state.prepares.push(structuredClone(task.plans));return prepare(task);};
 return f;
}
export function dualDraftObservation(task,{now=Date.now(),capFen=null,floorFen=null,errorsById={}}={}){
 const p=task.plans[0],rows=p.skus.map(s=>({...s,productId:p.productId,errors:[...(errorsById[s.id]||[]),...(capFen!=null&&s.saleFen>capFen?['活动价不得高于'+capFen/100+'元']:[]),...(floorFen!=null&&s.saleFen<floorFen?['活动价不得低于'+floorFen/100+'元']:[])]}));
 return{source:'live-platform-draft',kind:'draft',shopId:task.shopId,title:task.title,complete:true,observedAt:now,type:p.type,rules:structuredClone(p.rules),startAt:now,endAt:now+(p.durationMs??48*3600000),...(p.type==='限量抢购'?{productLimits:[{productId:p.productId,activityLimit:p.activityLimit}]}:{}),rows,warnings:[...new Set(rows.flatMap(r=>r.errors))],dialogs:[]};
}
export function dualDecisionFixture(journal,{now=Date.now(),caps={'限时抢购':5900,'限量抢购':5900},floors={},...options}={}){
 const f=dualActivityFixture(journal,{now,caps,floors,...options}),current={...structuredClone(f.baseline),complete:true,offShelf:false,observedAt:now},plan=planOriginalRestore(f.baseline,current,f.policy,now);
 const grant=activeDualActivityCareGrant(journal,plan.shopId,now);
 const probes=['限时抢购','限量抢购'].map(type=>{const task={id:randomUUID(),title:'fixture-dual-'+type,shopId:plan.shopId,phase:'queued',plans:[dualProbePlan(plan,type,grant.choices)],submitAttempts:0,riskAttempts:0,dualProbe:{grantId:grant.id,choices:structuredClone(grant.choices),plan:structuredClone(plan)}};return{type,task,observation:dualDraftObservation(task,{now,capFen:caps[type],floorFen:floors[type]})};});
 const decision=makeDualActivityDecision({plan,probes,now}),saved=journal.recordDualActivityDecision(decision,now);return {...f,plan,probes,decision:saved};
}
