import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,planOriginalRestore,proveDraft} from '../src/policy.mjs';
import {makeSubmissionInvestigation,submissionQueryScope,submissionTaskFingerprint} from '../src/submission-investigation.mjs';
import {consentForTasks,validateUnresolvedRecoveryConsent,makeRetirement,successorLossKey,validateRetiredTask} from '../src/unresolved-recovery.mjs';
import {dualProbePlan} from '../src/dual-activity-recovery.mjs';

function fixture({limited=false,age=16*3600000}={}){
 const now=1793754000000,at=now-age,shopId='900001',productId='300001',type=limited?'限量抢购':'限时抢购';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400001',type,
  rules:{noLimit:!limited,noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(limited?{autoRenew:true}:{})},
  ...(limited?{activityLimit:1000,durationMs:7*86400000}:{}),skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60},{id:'500002',name:'规格乙',baseFen:12000,discount:60}]};
 const plan=planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:at,skus:baseline.skus},{shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true},at);
 const task={id:'old-unknown-task',shopId,title:'守护2-原未知意图',phase:'unknown',updatedAt:at+2,createdAt:at,submittedAt:at+1,submitAttempts:1,riskAttempts:0,plans:[plan],reason:'原请求45秒超时',lossEvidence:{complete:true,lossKey:'old-loss',observedAt:at}};
 const observation={kind:'draft',shopId,title:task.title,type,rules:plan.rules,complete:true,observedAt:at,startAt:at,endAt:at+(limited?7*86400000:48*3600000),
  rows:plan.skus.map(s=>({...s,productId})),warnings:[],dialogs:[],...(limited?{productLimits:[{productId,activityLimit:1000}]}:{})};
 task.draftProof=proveDraft(task,observation,at);
 const options={shopId,runtimeId:'local-installation-A',authorizationRef:'user-current-known-unknown-two-products',acceptHistoricalUnknown:true,acceptOneNewLifecycle:true,noPriceReductions:true,noQuotaIncrease:true,at:now-100,expiresAt:now+3600000};
 const consent=consentForTasks([task],options,now),context={now,runtimeId:options.runtimeId,histories:[baseline],actorExit:{source:'owned-process-tree-exit',complete:true,shopId,
  taskFingerprint:submissionTaskFingerprint(task),observedAt:now-10000,allExited:true,processIds:[101,102],currentDraftAbsent:true},quantityProofs:[]};
 const listing=(query,time,campaigns=[])=>{
  const filters={source:'rendered-list-query-controls',observedAt:time,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],selectedFilters:[],selectedTabs:[],
   dateControls:[{placeholder:'开始日期',value:''},{placeholder:'结束日期',value:''}]};
  const queryScope=submissionQueryScope({shopId,query,before:filters,after:structuredClone(filters),pages:1});queryScope.activityTypes=['限时抢购','限量抢购'];
  return{complete:true,shopId,observedAt:time,query,campaigns,queryScope};
 };
 const makeRaw=time=>{
  const source={id:baseline.campaignId,name:'更早的准确历史来源',type,status:'已失效',startAt:at-7*86400000,endAt:at-1000,risk:true};
  const detail={complete:true,observedAt:time+10,rules:baseline.rules,products:[{productId,activityLimit:limited?1000:undefined,soldOut:false,removalConfirmed:true,removalRiskConfirmed:true,removalAmbiguous:false,skus:plan.skus}]};
  const productQueries=[null,'进行中','未开始'].map(status=>({productId,status,listing:listing({productId,title:null,status},time,limited&&status===null?[source]:[]),error:null}));
  return makeSubmissionInvestigation(task,{startedAt:time,finishedAt:time+20,titleListing:listing({productId:null,title:task.title,status:null},time),productQueries,
   details:limited?[{campaignId:source.id,shopId,campaign:source,detail}]:[],referenceQueries:limited?[{productId,historicalFingerprint:plan.historicalFingerprint,sourceCampaignId:source.id,lookup:'present-in-product-query',matchedCampaignIds:[source.id],hintOnly:true}]:[]});
 };
 const raws=[makeRaw(now-4000),makeRaw(now-2000)];
 if(limited){const entry=raws[1].details[0];context.quantityProofs.push({source:'live-platform-limited-quota',complete:true,shopId,productId,campaignId:entry.campaignId,historicalFingerprint:plan.historicalFingerprint,observedAt:entry.detail.observedAt,soldOut:false,activityLimit:1000,evidenceFingerprint:fingerprint({campaign:entry.campaign,detail:entry.detail})});}
 return{now,task,options,consent,context,raws,listing,retire(){return makeRetirement(this.task,this.raws,this.consent,this.context);}};
}
test('a scoped current recovery intent can retire a future-window historical unknown without claiming original failure or changing any input',()=>{
 const f=fixture(),before=fingerprint(f),result=f.retire();assert.equal(result.allowed,true,JSON.stringify(result));assert.equal(result.closure.historicalOutcome,'unknown');assert.equal(result.closure.success,false);assert.equal(result.closure.marksOriginalRequestFailed,false);assert.equal(result.closure.oldTaskMayRequeue,false);assert.equal(result.closure.grantsNewPriceAuthority,false);assert.equal(result.closure.maxSubmittedSuccessors,1);assert.equal(fingerprint(f),before);
 assert.ok(f.task.draftProof.observation.endAt>f.now,'elapsed intent is not mistaken for expired planned activity');
 const again=f.retire();assert.equal(again.closure.id,result.closure.id);assert.equal(again.newCycleKey,result.newCycleKey);assert.equal(successorLossKey(result.closure,'fresh-loss'),successorLossKey(again.closure,'fresh-loss'));assert.notEqual(successorLossKey(result.closure,'fresh-loss'),'old-loss');
});
test('exact inactive non-soldout limited source and actual quota proof survive in the non-success closure',()=>{
 const f=fixture({limited:true}),r=f.retire();assert.equal(r.allowed,true,JSON.stringify(r));assert.equal(r.closure.quantityBounds[0].sourceCampaignId,'400001');assert.equal(r.closure.quantityBounds[0].maxActivityLimit,1000);assert.equal(r.closure.noQuotaIncrease,true);assert.equal(f.task.riskAttempts,0);
});
for(const change of ['runtime','shop','other-task','expired','counter','risk-proof','draft-proof','price','omitted-ack'])test('incident consent cannot transfer authority or hide changed original material: '+change,()=>{
 const f=fixture();let c=f.consent,t=f.task,ctx={runtimeId:f.context.runtimeId,now:f.now};
 if(change==='runtime')ctx.runtimeId='other-installation';if(change==='shop')t={...t,shopId:'900002'};if(change==='other-task')t={...t,id:'another-unknown'};
 if(change==='expired')ctx.now=c.expiresAt;if(change==='counter')t={...t,riskAttempts:1};if(change==='risk-proof')t={...t,riskProof:{at:f.now-1000}};
 if(change==='draft-proof')t={...t,draftProof:{...t.draftProof,materialFingerprint:'0'.repeat(64)}};
 if(change==='price'){t=structuredClone(t);t.plans[0].skus[0].saleFen--;}
 if(change==='omitted-ack'){assert.throws(()=>consentForTasks([t],{...f.options,noQuotaIncrease:false},f.now));return;}
 assert.equal(validateUnresolvedRecoveryConsent(c,t,ctx).allowed,false);
});
for(const change of ['only-one-read','same-read','stale','wrong-query','scope-changed','date-missing','date-short','type-missing','current-candidate','detail-incomplete','pending-state','actor-alive','actor-time','draft-present','short-settlement'])test('retirement refuses insufficient current proof: '+change,()=>{
 const f=fixture({age:change==='short-settlement'?300000:16*3600000});
 if(change==='only-one-read')f.raws.pop();if(change==='same-read')f.raws[1]=f.raws[0];if(change==='stale')f.context.now+=120001;
 if(change==='wrong-query')f.raws[1].titleQuery.listing.query.title='wrong';
 if(change==='scope-changed')f.raws[1].productQueries[1].listing.queryScope.after.selections=['全部'];
 if(change==='date-missing')for(const r of f.raws)r.titleQuery.listing.queryScope.before.dateControls=r.titleQuery.listing.queryScope.after.dateControls=[];
 if(change==='date-short')for(const r of f.raws)for(const side of ['before','after'])r.titleQuery.listing.queryScope[side].dateControls=[{placeholder:'开始日期',value:'2026/11/04'},{placeholder:'结束日期',value:'2026/11/04'}];
 if(change==='type-missing')delete f.raws[1].productQueries[1].listing.queryScope.activityTypes;
 if(['current-candidate','detail-incomplete','pending-state'].includes(change)){
  const r=f.raws[1],c={id:'400002',name:'other',type:'限时抢购',status:change==='pending-state'?'创建中':'进行中',startAt:f.now-1000,endAt:f.now+100000};
  r.productQueries[0].listing.campaigns=[c];r.details=[{campaignId:c.id,shopId:f.task.shopId,campaign:c,detail:{complete:change!=='detail-incomplete',observedAt:f.now-100,products:[{productId:'300001',removalConfirmed:false,removalAmbiguous:false}]}}];
 }
 if(change==='actor-alive')f.context.actorExit.allExited=false;if(change==='actor-time')f.context.actorExit.observedAt=f.task.submittedAt-1;if(change==='draft-present')f.context.actorExit.currentDraftAbsent=false;
 assert.equal(f.retire().allowed,false,change);
});
test('an independently captured official date/type scope is required to replace unobserved date controls',()=>{
 const f=fixture();for(const r of f.raws){
  const campaign={id:'400008',name:'统计日期以外的旧活动',type:'限时抢购',status:'已结束',startAt:f.task.createdAt-5*86400000,endAt:f.task.createdAt-4*86400000};
  r.productQueries[0].listing.campaigns=[campaign];r.details=[{campaignId:campaign.id,shopId:f.task.shopId,campaign,detail:{complete:true,observedAt:r.finishedAt-1,products:[{productId:'300001',removalConfirmed:true,removalAmbiguous:false}]}}];
  for(const listing of [r.titleQuery.listing,...r.productQueries.map(p=>p.listing)]){
   for(const side of ['before','after']){const s=listing.queryScope[side];s.dateControls=[];s.querySurface={source:'rendered-official-query-surface',pathname:s.pathname,complete:true,
    queryRegion:{source:'minimal-common-query-ancestor',containsStatistics:false,queryButtonCount:1,resetButtonCount:1,titleInputCount:1,productInputCount:1,
     fields:[{placeholder:'请输入活动名称',recognized:true,value:listing.query.title||''},{placeholder:'请输入商品ID',recognized:true,value:listing.query.productId||''}],
     selects:[{label:'活动状态',selected:listing.query.status||'全部'},{label:'优惠类型',selected:'',empty:true,placeholder:'请选择'},{label:'活动类型',selected:'',empty:true,placeholder:'请选择'}],tabs:[],selectedExtras:[],dateControls:[]},
    statisticsDates:[{source:'separate-order-statistics-region',separateFromQuery:true,context:'数据概览 以下数据仅统计生效单品直降的商品订单数据',range:['2026/11/03','2026/11/03']}]};}
   delete listing.queryScope.activityTypes;
  }
 }
 assert.equal(f.retire().allowed,true,JSON.stringify(f.retire()));const listing=f.raws[0].titleQuery.listing;
 f.context.coverageProofs=[{source:'live-platform-official-query-coverage',complete:true,shopId:f.task.shopId,observedAt:listing.observedAt,listingFingerprint:fingerprint(listing),allDates:true,activityTypes:['限时抢购','限量抢购'],evidenceFingerprint:'0'.repeat(64)}];assert.equal(f.retire().allowed,false,'bare booleans/hash cannot replace actual official scope evidence');
});
for(const change of ['no-proof','sold-out','missing-soldout','wrong-source','larger-cap','remaining','cancelled'])test('limited retirement never fills missing quota facts with operator consent: '+change,()=>{
 const f=fixture({limited:true}),entry=f.raws[1].details[0],p=f.context.quantityProofs[0];
 if(change==='no-proof')f.context.quantityProofs=[];if(change==='sold-out')entry.detail.products[0].soldOut=true;if(change==='missing-soldout')delete entry.detail.products[0].soldOut;
 if(change==='wrong-source')f.raws[1].referenceQueries[0].sourceCampaignId='499999';if(change==='larger-cap')p.activityLimit=1001;if(change==='remaining')p.remainingQuota=999;
 if(change==='cancelled'){entry.campaign.status='已作废';f.raws[1].productQueries[0].listing.campaigns[0].status='已作废';}
 assert.equal(f.retire().allowed,false,change);
});
test('task archival may change only terminal phase/reason/time; original counters, plans and proofs remain immutable',()=>{
 const f=fixture(),result=f.retire(),current={...structuredClone(f.task),phase:'blocked',reason:result.reason,updatedAt:f.now};assert.equal(validateRetiredTask(f.task,current,result.closure).allowed,true);
 for(const field of ['submitAttempts','riskAttempts','title','draftProof','riskProof','receipt','plans']){const changed=structuredClone(current);changed[field]=field.endsWith('Attempts')?1-changed[field]:null;assert.equal(validateRetiredTask(f.task,changed,result.closure).allowed,false,field);}
 assert.equal(validateRetiredTask(f.task,{...current,phase:'queued'},result.closure).allowed,false);
});
test('proof collected before the original actor exited cannot become a post-exit absence proof',()=>{
 const f=fixture();f.context.actorExit.observedAt=f.now-1000;assert.equal(f.retire().code,'UNRESOLVED_ACTOR');
});
test('one removed duplicate row cannot hide another active membership of the same product',()=>{
 const f=fixture(),r=f.raws[1],c={id:'400009',name:'duplicate-members',type:'限时抢购',status:'进行中',startAt:f.now-10,endAt:f.now+100000};
 r.productQueries[0].listing.campaigns=[c];r.details=[{campaignId:c.id,shopId:f.task.shopId,campaign:c,detail:{complete:true,observedAt:f.now-100,products:[{productId:'300001',removalConfirmed:true},{productId:'300001',removalConfirmed:false}]}}];
 assert.equal(f.retire().allowed,false);
});
test('incomplete data returns a blocked decision, never a fabricated successful closure',()=>{
 const f=fixture();f.raws[1].productQueries={};assert.doesNotThrow(()=>f.retire());assert.equal(f.retire().allowed,false);
 const changed={...f.consent,scopes:{}};changed.key=fingerprint({...changed,key:undefined});assert.equal(validateUnresolvedRecoveryConsent(changed,f.task,f.context).allowed,false);
});
test('one product investigation cannot retire the whole original multi-product task',()=>{
 const f=fixture(),baseline={...structuredClone(f.context.histories[0]),productId:'300002',campaignId:'400002',skus:f.context.histories[0].skus.map(s=>({...s,id:String(Number(s.id)+100)}))};
 const second=planOriginalRestore(baseline,{shopId:baseline.shopId,productId:baseline.productId,complete:true,observedAt:f.task.createdAt,skus:baseline.skus},{shopId:baseline.shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true},f.task.createdAt);
 f.task.plans.push(second);const observation=structuredClone(f.task.draftProof.observation);observation.rows.push(...second.skus.map(s=>({...s,productId:second.productId})));f.task.draftProof=proveDraft(f.task,observation,f.task.createdAt);f.context.histories.push(baseline);
 f.consent=consentForTasks([f.task],f.options,f.now);f.context.actorExit.taskFingerprint=submissionTaskFingerprint(f.task);for(const r of f.raws)r.taskFingerprint=submissionTaskFingerprint(f.task);
 assert.equal(f.retire().allowed,false);
});
test('contradictory risk proof cannot be accepted merely because the operator knows a request is unknown',()=>{
 const f=fixture();f.task.riskProof={taskId:f.task.id,kind:'original-discount-risk',at:f.task.submittedAt};assert.throws(()=>consentForTasks([f.task],f.options,f.now),{code:'UNRESOLVED_RISK'});
});
test('returned closure price floors do not alias the persisted incident consent',()=>{
 const f=fixture(),before=fingerprint(f.consent),result=f.retire();result.closure.priceFloors[0].skus[0].saleFen--;assert.equal(fingerprint(f.consent),before);assert.equal(validateRetiredTask(f.task,{...f.task,phase:'blocked'},result.closure).allowed,false);
});
function timedSourceLimitedIntent(){
 const f=fixture(),old=f.task.plans[0],plan=dualProbePlan(old,'限量抢购');f.task.plans=[plan];
 const observation={...f.task.draftProof.observation,type:plan.type,rules:plan.rules,endAt:f.task.createdAt+plan.durationMs,productLimits:[{productId:plan.productId,activityLimit:plan.activityLimit}]};
 f.task.draftProof=proveDraft(f.task,observation,f.task.createdAt);f.consent=consentForTasks([f.task],f.options,f.now);f.context.actorExit.taskFingerprint=submissionTaskFingerprint(f.task);
 for(const r of f.raws){r.taskFingerprint=submissionTaskFingerprint(f.task);const campaign={id:'400001',name:'实际限时来源',type:'限时抢购',status:'已结束',startAt:f.task.createdAt-48*3600000,endAt:f.task.createdAt-1000};
  r.productQueries[0].listing.campaigns=[campaign];r.referenceQueries=[{productId:plan.productId,historicalFingerprint:plan.historicalFingerprint,sourceCampaignId:campaign.id,lookup:'present-in-product-query',hintOnly:true}];
  r.details=[{campaignId:campaign.id,shopId:f.task.shopId,campaign,detail:{complete:true,observedAt:r.finishedAt-1,rules:old.rules,products:[{productId:plan.productId,skus:old.skus,removalConfirmed:false,removalAmbiguous:false,soldOut:false}]}}];
 }
 return f;
}
test('a timed historical source and an unproven old limited intent permit ONLY timed recovery, never new limited quota',()=>{
 const f=timedSourceLimitedIntent(),r=f.retire();assert.equal(r.allowed,true,JSON.stringify(r));assert.deepEqual(r.closure.allowedTypes,['限时抢购']);assert.equal(r.closure.forbidNewLimitedQuota,true);assert.deepEqual(r.closure.priceFloors[0].allowedTypes,['限时抢购']);assert.equal(r.closure.quantityBounds.length,0);assert.equal(r.closure.perProduct[0].sourceCampaignId,'400001');
});
test('the timed-only exception cannot erase a genuine limited loss source',()=>{
 const f=timedSourceLimitedIntent();f.task.lossEvidence.priceRules=[{removalEvidence:{source:'live-platform-removal-export',campaignId:'400003',activityType:'限量抢购',record:{productId:'300001'}}}];
 f.consent=consentForTasks([f.task],f.options,f.now);f.context.actorExit.taskFingerprint=submissionTaskFingerprint(f.task);for(const r of f.raws)r.taskFingerprint=submissionTaskFingerprint(f.task);
 assert.equal(f.retire().code,'UNRESOLVED_QUANTITY');
});
function addRecordedTimedLoss(f){
 f.task.lossEvidence.priceRules=[{removalEvidence:{source:'live-platform-removal-export',campaignId:'400003',activityType:'限时抢购',record:{productId:'300001'}}}];
 f.consent=consentForTasks([f.task],f.options,f.now);f.context.actorExit.taskFingerprint=submissionTaskFingerprint(f.task);
 for(const r of f.raws){r.taskFingerprint=submissionTaskFingerprint(f.task);const entry=structuredClone(r.details[0]);entry.campaignId='400003';entry.campaign.id='400003';entry.campaign.name='当次真实失效来源';r.details.push(entry);r.productQueries[0].listing.campaigns.push(entry.campaign);}
 return f;
}
test('a recorded loss source already read by a product query needs no duplicate referenceQueries hint',()=>{
 const f=addRecordedTimedLoss(timedSourceLimitedIntent());assert.deepEqual(f.raws[1].referenceQueries.map(r=>r.sourceCampaignId),['400001']);
 const r=f.retire();assert.equal(r.allowed,true,JSON.stringify(r));assert.deepEqual(r.closure.allowedTypes,['限时抢购']);assert.equal(r.closure.perProduct[0].sourceCampaignId,'400003');assert.equal(r.closure.sourceReferences.find(s=>s.kind==='recorded-loss').campaignId,'400003');
});
for(const failure of ['missing','duplicate','wrong-shop','wrong-type','incomplete'])test('the exact recorded loss detail cannot be replaced or guessed: '+failure,()=>{
 const f=addRecordedTimedLoss(timedSourceLimitedIntent()),r=f.raws[1],entry=r.details.find(d=>d.campaignId==='400003');
 if(failure==='missing'){r.details=r.details.filter(d=>d!==entry);r.productQueries[0].listing.campaigns=r.productQueries[0].listing.campaigns.filter(c=>c.id!=='400003');}
 if(failure==='duplicate')r.details.push(structuredClone(entry));if(failure==='wrong-shop')entry.shopId='900002';if(failure==='wrong-type')entry.campaign.type='限量抢购';if(failure==='incomplete')entry.detail.complete=false;
 assert.equal(f.retire().allowed,false,failure);
});
function shiftReads(value,delta){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(['observedAt','startedAt','finishedAt'].includes(key)&&typeof item==='number')value[key]+=delta;else shiftReads(item,delta);}}
test('two long ordered investigations may age history within ten minutes while the latest current/upcoming queries remain fresh',()=>{
 const f=fixture();shiftReads(f.raws[0],-200000);shiftReads(f.raws[1],-80000);f.context.actorExit.observedAt=f.now-300000;assert.equal(f.retire().allowed,true,JSON.stringify(f.retire()));
});
test('ten-minute history tolerance never extends the latest current/upcoming 120-second freshness',()=>{
 const f=fixture();shiftReads(f.raws[0],-250000);shiftReads(f.raws[1],-130000);f.context.actorExit.observedAt=f.now-300000;assert.equal(f.retire().code,'UNRESOLVED_CURRENT_STALE');
});
test('historical evidence older than the ten-minute bound remains blocked',()=>{
 const f=fixture();shiftReads(f.raws[0],-601000);f.context.actorExit.observedAt=f.now-610000;assert.equal(f.retire().code,'UNRESOLVED_INVESTIGATION');
});
