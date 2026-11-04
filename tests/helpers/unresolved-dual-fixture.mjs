import {randomUUID} from 'node:crypto';
import {AccountRegistry} from '../../src/accounts.mjs';
import {fingerprint,planOriginalRestore,proveDraft} from '../../src/policy.mjs';
import {activeDualActivityCareGrant,setDualActivityCarePolicy,dualProbePlan,makeDualActivityDecision} from '../../src/dual-activity-recovery.mjs';
import {consentForTasks,makeRetirement} from '../../src/unresolved-recovery.mjs';
import {submissionQueryScope,makeSubmissionInvestigation,submissionTaskFingerprint} from '../../src/submission-investigation.mjs';
import {dualDraftObservation} from './dual-activity-fixture.mjs';

// Real Journal archive/consent/decision, synthetic native observations only.
export function unresolvedDualFixture(journal,{now=Date.now(),timedCapFen=5900,limitedCapFen=null,preservedLimitedSource=false,recordDecision=true}={}){
 const at=now-16*3600000,shopId='900001',productId='300001';
 const accounts=new AccountRegistry(journal);accounts.register({shopId,name:'原未知意图隔离验收'},'signin-unresolved-scope');accounts.authorizeOriginal(shopId);
 setDualActivityCarePolicy(journal,shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},now);
 const grant=activeDualActivityCareGrant(journal,shopId,now),baseline={source:'verified-platform-history',complete:true,shopId,productId,name:'原未知商品',campaignId:'400001',type:'限时抢购',
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60},{id:'500002',name:'规格乙',baseFen:12000,discount:60}]};
 journal.remember(baseline,at);
 const current=time=>({shopId,productId,complete:true,observedAt:time,skus:structuredClone(baseline.skus)}),policy={shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true};
 const plan=planOriginalRestore(baseline,current(now),policy,now),oldPlan=dualProbePlan(planOriginalRestore(baseline,current(at),policy,at),preservedLimitedSource?'限时抢购':'限量抢购',grant.choices);
 const task={id:randomUUID(),shopId,title:'守护2-旧意图未核实',phase:'unknown',updatedAt:at+1,createdAt:at,submittedAt:at,submitAttempts:1,riskAttempts:preservedLimitedSource?1:0,plans:[oldPlan],lossEvidence:{complete:true,observedAt:at,lossKey:'source-unknown',...(preservedLimitedSource?{priceRules:[{removalEvidence:{source:'live-platform-removal-export',campaignId:'400003',activityType:'限量抢购',record:{productId}}}]}:{})},reason:'原平台结果未确定'};
 const observation={...dualDraftObservation({...task,plans:[oldPlan]},{now:at}),source:undefined};task.draftProof=proveDraft(task,observation,at);
 if(preservedLimitedSource){task.riskAttemptedAt=at+1;task.riskProof={taskId:task.id,kind:'original-discount-risk',at:at+1,observation:{...structuredClone(observation),observedAt:at+1,dialogs:[`1 个商品存在低价风险，请谨慎新建 ID：${productId} 预估最低到手价 仍要创建`]}};}
 const {id,shopId:shop,phase,updatedAt,...body}=task;journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,shop,'original-'+id,phase,JSON.stringify(body),updatedAt);
 const listing=(query,time,campaigns=[])=>{const f={source:'rendered-list-query-controls',observedAt:time,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],selectedFilters:[],selectedTabs:[],dateControls:[{placeholder:'开始日期',value:''},{placeholder:'结束日期',value:''}]},queryScope=submissionQueryScope({shopId,query,before:f,after:structuredClone(f),pages:1});queryScope.activityTypes=['限时抢购','限量抢购'];return{complete:true,shopId,observedAt:time,query,campaigns,queryScope};};
 const raw=time=>{const campaign={id:baseline.campaignId,name:'原限时价格来源',type:'限时抢购',status:'已结束',startAt:at-48*3600000,endAt:at-1000},detail={complete:true,observedAt:time+10,rules:baseline.rules,products:[{productId,skus:plan.skus,soldOut:false,removalConfirmed:false,removalAmbiguous:false}]};
  const details=[{campaignId:campaign.id,shopId,campaign,detail}],campaigns=[campaign],referenceQueries=[{productId,historicalFingerprint:plan.historicalFingerprint,sourceCampaignId:campaign.id,lookup:'present-in-product-query',hintOnly:true}];
  if(preservedLimitedSource){const source={...campaign,id:'400003',name:'实际限量退出来源',type:'限量抢购',status:'已失效'},sourceDetail={...structuredClone(detail),rules:grant.choices.find(c=>c.type==='限量抢购').rules,products:[{productId,skus:plan.skus,soldOut:false,activityLimit:1000,removalConfirmed:true,removalAmbiguous:false}]};campaigns.push(source);details.push({campaignId:source.id,shopId,campaign:source,detail:sourceDetail});referenceQueries.push({productId,historicalFingerprint:plan.historicalFingerprint,sourceCampaignId:source.id,lookup:'present-in-product-query',hintOnly:true});}
  return makeSubmissionInvestigation(task,{startedAt:time,finishedAt:time+20,titleListing:listing({productId:null,title:task.title,status:null},time),productQueries:[null,'进行中','未开始'].map(status=>({productId,status,error:null,listing:listing({productId,title:null,status},time,status===null?campaigns:[])})),details,referenceQueries});};
 const raws=[raw(now-4000),raw(now-2000)],context={now,runtimeId:'isolated-unresolved-dual',histories:journal.histories(shopId),activityGrant:grant,actorExit:{source:'owned-process-tree-exit',complete:true,shopId,taskFingerprint:submissionTaskFingerprint(task),observedAt:now-10000,allExited:true,currentDraftAbsent:true,processIds:[101,102]}};
 const consent=consentForTasks([task],{shopId,runtimeId:context.runtimeId,authorizationRef:'current-user-known-unknown-recovery',acceptHistoricalUnknown:true,acceptOneNewLifecycle:true,noPriceReductions:true,noQuotaIncrease:true,at:now-100,expiresAt:now+3600000},now);
 if(preservedLimitedSource){const entry=raws[1].details.find(d=>d.campaignId==='400003');context.quantityProofs=[{source:'live-platform-limited-quota',complete:true,shopId,productId,campaignId:entry.campaignId,historicalFingerprint:plan.historicalFingerprint,observedAt:entry.detail.observedAt,soldOut:false,activityLimit:1000,evidenceFingerprint:fingerprint({campaign:entry.campaign,detail:entry.detail})}];}
 const retirement=makeRetirement(task,raws,consent,context);if(!retirement.allowed)throw Error(JSON.stringify(retirement));
 const archive=journal.retireUnresolved(task.id,retirement,now);
 const probes=['限时抢购','限量抢购'].map(type=>{const probeTask={id:randomUUID(),title:'scope-probe-'+randomUUID(),shopId,phase:'queued',submitAttempts:0,riskAttempts:0,plans:[dualProbePlan(plan,type,grant.choices)],dualProbe:{grantId:grant.id,choices:structuredClone(grant.choices),plan:structuredClone(plan)}};return{type,task:probeTask,observation:dualDraftObservation(probeTask,{now,capFen:type==='限时抢购'?timedCapFen:limitedCapFen})};});
 const made=makeDualActivityDecision({plan,probes,now,scopeRestriction:archive.closure,journal}),decision=recordDecision?journal.recordDualActivityDecision(made,now):made;
 return{journal,now,shopId,productId,baseline,policy,plan,task,consent,context,raws,retirement,archive,probes,decision,made,current};
}
