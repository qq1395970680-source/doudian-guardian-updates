import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {planOriginalRestore,proveDraft} from '../src/policy.mjs';
import {adjudicateSubmissionInvestigation,makeSubmissionInvestigation,submissionQueryScope,submissionInvestigationKey,assessSubmissionQuery} from '../src/submission-investigation.mjs';

function fixture(){
 const now=Date.now(),j=new Journal(':memory:'),shopId='900001',productId='300001';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400001',type:'限时抢购',durationMs:172800000,
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60}]};
 const plan=planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:now,skus:baseline.skus},{shopId,originalRiskAllowed:true},now);
 const queued=j.enqueue(shopId,[plan],{complete:true,observedAt:now,lossKey:'fixture-submission'},now);
 const observation={kind:'draft',shopId,title:queued.title,complete:true,observedAt:now,type:plan.type,rules:plan.rules,startAt:now-1000,endAt:now-1000+plan.durationMs,
  rows:plan.skus.map(s=>({...s,productId})),warnings:[],dialogs:[]};
 j.transition(queued.id,'queued','prepared',{},now);j.beginSubmit(queued.id,proveDraft(queued,observation,now),now);j.transition(queued.id,'submitting','unknown',{reason:'response missing'},now);
 const task=j.get(queued.id),campaign={id:'400002',name:task.title,type:plan.type,status:'进行中',startAt:observation.startAt,endAt:observation.endAt},
  detail={complete:true,observedAt:now,rules:plan.rules,products:[{productId,name:'测试商品',skus:plan.skus,removalConfirmed:false,removalAmbiguous:false}]};
 const listing=(query,campaigns=[])=>{const before={source:'rendered-list-query-controls',observedAt:now,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],dateControls:[{placeholder:'开始日期',value:''},{placeholder:'结束日期',value:''}],selectedFilters:[],selectedTabs:[]};
  return{complete:true,shopId,observedAt:now,query,campaigns,queryScope:submissionQueryScope({shopId,query,before,after:structuredClone(before),pages:1})};};
 const raw=(campaigns=[],details=[])=>makeSubmissionInvestigation(task,{startedAt:now-2000,finishedAt:now,titleListing:listing({productId:null,title:task.title,status:null},campaigns),details,
  productQueries:['进行中','未开始'].map(status=>({productId,status,listing:listing({productId,title:null,status})}))});
 return{j,task,now,shopId,productId,plan,campaign,detail,listing,raw};
}
const run=(name,fn)=>test(name,async()=>{const f=fixture();try{await fn(f);}finally{f.j.close();}});

run('a complete exact active investigation proves the old activity without authorizing another write',f=>{
 const before=JSON.stringify(f.j.list(f.shopId)),r=adjudicateSubmissionInvestigation(f.task,f.raw([f.campaign],[{campaignId:f.campaign.id,shopId:f.shopId,detail:f.detail}]),{now:f.now});
 assert.equal(r.classification,'proven-active');assert.equal(r.receipt.campaignId,f.campaign.id);assert.equal(r.authorizesSubmit,false);assert.equal(r.mayCloseUnknown,false);assert.equal(JSON.stringify(f.j.list(f.shopId)),before);
});
run('two complete current-product empty searches still do not assert that an old submission failed',f=>{
 const r=adjudicateSubmissionInvestigation(f.task,f.raw(),{now:f.now});assert.equal(r.classification,'not-found');assert.equal(r.currentQueriesComplete,true);assert.equal(r.currentProductCandidates,false);assert.equal(r.mayCloseUnknown,false);assert.equal(f.j.get(f.task.id).submitAttempts,1);
});
run('another title is only a candidate even when its product and exact SKU prices match',f=>{
 const raw=f.raw([{...f.campaign,name:'活动已改名'}]);raw.productQueries[0].listing.campaigns=[{...f.campaign,name:'活动已改名'}];
 const r=adjudicateSubmissionInvestigation(f.task,raw,{now:f.now});assert.equal(r.classification,'not-found');assert.equal(r.currentProductCandidates,true);assert.match(r.reason,/其他活动候选/);assert.equal(r.authorizesSubmit,false);
});
run('inactive exact source preserves the sold-out facts and is never a failed-submit or refill approval',f=>{
 const campaign={...f.campaign,status:'已结束',type:'限量抢购'},detail={...f.detail,products:[{...f.detail.products[0],soldOut:true,activityLimit:1000}]};
 const r=adjudicateSubmissionInvestigation(f.task,f.raw([campaign],[{campaignId:campaign.id,shopId:f.shopId,detail}]),{now:f.now});assert.equal(r.classification,'inactive');assert.equal(r.campaign.id,campaign.id);assert.equal(r.detail.products[0].soldOut,true);assert.equal(r.detail.products[0].activityLimit,1000);assert.equal(r.mayCloseUnknown,false);
});
run('a lightweight inactive-title read records that branch even before its detail has been investigated',f=>{
 const r=adjudicateSubmissionInvestigation(f.task,f.raw([{...f.campaign,status:'已失效'}]),{now:f.now});assert.equal(r.classification,'inactive');assert.match(r.reason,/详情.*仍需读取/);assert.equal(r.mayCloseUnknown,false);
});
for(const change of ['price','membership','range','removed','detail-shop'])run('active candidate rejects mismatched '+change,f=>{
 const campaign=structuredClone(f.campaign),detail=structuredClone(f.detail),entry={campaignId:campaign.id,shopId:f.shopId,detail};
 if(change==='price')detail.products[0].skus[0].saleFen--;
 if(change==='membership')detail.products[0].skus=[];
 if(change==='range'){campaign.startAt+=1000;campaign.endAt+=1000;}
 if(change==='removed')detail.products[0].removalConfirmed=true;
 if(change==='detail-shop')entry.shopId='900002';
 const r=adjudicateSubmissionInvestigation(f.task,f.raw([campaign],[entry]),{now:f.now});assert.notEqual(r.classification,'proven-active');assert.equal(r.authorizesSubmit,false);assert.equal(r.mayCloseUnknown,false);
});
run('a duplicate exact title is ambiguous even when one candidate has valid details',f=>{
 const r=adjudicateSubmissionInvestigation(f.task,f.raw([f.campaign,{...f.campaign,id:'400003'}],[{campaignId:f.campaign.id,shopId:f.shopId,detail:f.detail}]),{now:f.now});assert.equal(r.classification,'ambiguous');assert.equal(r.mayCloseUnknown,false);
});
for(const change of ['shop','task','plan','counter','draft','submitted-at','risk-proof'])run('investigation cannot be replayed after changed '+change,f=>{
 const raw=f.raw(),task=structuredClone(f.task);if(change==='shop')task.shopId='900002';if(change==='task')task.id='another';if(change==='plan')task.plans[0].skus[0].saleFen++;if(change==='counter')task.riskAttempts++;if(change==='draft')task.draftProof.observation.endAt++;if(change==='submitted-at')task.submittedAt++;if(change==='risk-proof')task.riskProof={at:f.now};
 assert.equal(adjudicateSubmissionInvestigation(task,raw,{now:f.now}).classification,'unproven');
});
for(const change of ['stale','missing-filter','filter-drift','wrong-query','wrong-shop','status-drift'])run('incomplete query evidence cannot establish absence: '+change,f=>{
 const raw=f.raw(),listing=change==='status-drift'?raw.productQueries[0].listing:raw.titleQuery.listing;
 if(change==='stale')listing.observedAt=f.now-120001;
 if(change==='missing-filter')delete listing.queryScope;
 if(change==='filter-drift')listing.queryScope.after.titles=['another'];
 if(change==='wrong-query')listing.query.title='another';
 if(change==='wrong-shop')listing.shopId='900002';
 if(change==='status-drift')listing.campaigns=[{...f.campaign,status:'已结束'}];
 const r=adjudicateSubmissionInvestigation(f.task,raw,{now:f.now});if(change==='status-drift')assert.equal(r.currentQueriesComplete,false);else assert.equal(r.classification,'unproven');assert.equal(r.mayCloseUnknown,false);
});
run('date visibility and a date range covering submission are stated separately from absence',f=>{
 const query={productId:null,title:f.task.title,status:null},l=f.listing(query);let r=assessSubmissionQuery(l,query,f.task,f.now);assert.equal(r.dateCoverage.state,'unbounded-visible');assert.equal(r.dateCoverage.coversSubmission,true);
 l.queryScope.before.dateControls=l.queryScope.after.dateControls=[];r=assessSubmissionQuery(l,query,f.task,f.now);assert.equal(r.dateCoverage.state,'not-observed');assert.equal(r.dateCoverage.coversSubmission,undefined);
 for(const s of [l.queryScope.before,l.queryScope.after])s.dateControls=[{placeholder:'开始日期',value:'2000/01/01'},{placeholder:'结束日期',value:'2100/01/01'}];
 r=assessSubmissionQuery(l,query,f.task,f.now);assert.equal(r.dateCoverage.state,'bounded');assert.equal(r.dateCoverage.coversSubmission,true);
 for(const s of [l.queryScope.before,l.queryScope.after])s.dateControls[1].value='2000/01/02';assert.equal(assessSubmissionQuery(l,query,f.task,f.now).dateCoverage.coversSubmission,false);
});
run('a missing date endpoint, duplicate labels or impossible calendar day cannot claim date coverage',f=>{
 const query={productId:null,title:f.task.title,status:null},l=f.listing(query);
 for(const s of [l.queryScope.before,l.queryScope.after])s.dateControls=[{placeholder:'开始日期',value:''}];assert.equal(assessSubmissionQuery(l,query,f.task,f.now).dateCoverage.state,'unproven');
 for(const s of [l.queryScope.before,l.queryScope.after])s.dateControls=[{placeholder:'开始日期',value:''},{placeholder:'开始日期',value:''}];assert.equal(assessSubmissionQuery(l,query,f.task,f.now).dateCoverage.state,'unproven');
 for(const s of [l.queryScope.before,l.queryScope.after])s.dateControls=[{placeholder:'开始日期',value:'2026/02/30'},{placeholder:'结束日期',value:'2100/01/01'}];assert.equal(assessSubmissionQuery(l,query,f.task,f.now).dateCoverage.state,'unproven');
});
run('an unrecognized creation or renewal status cannot be treated as an inactive terminal result',f=>{
 const r=adjudicateSubmissionInvestigation(f.task,f.raw([{...f.campaign,status:'创建中'}]),{now:f.now});assert.equal(r.classification,'unproven');assert.equal(r.mayCloseUnknown,false);
});
run('read failures retain their actual cause rather than becoming an empty successful query',f=>{
 const raw=f.raw();raw.titleQuery.error={code:'LOAD_TIMEOUT',message:'店铺名称尚未加载'};raw.titleQuery.listing=null;
 const r=adjudicateSubmissionInvestigation(f.task,raw,{now:f.now});assert.equal(r.classification,'read-failed');assert.match(r.reason,/店铺名称尚未加载/);assert.equal(r.mayCloseUnknown,false);
});
run('ordinary readback null persists a structured missing-title diagnostic while preserving task financial fields',async f=>{
 const platform=new DoudianPlatform({browser:{test:true},policy:{shopId:f.shopId},journal:f.j,base:'http://127.0.0.1:12345'});platform.list=async()=>f.raw().titleQuery.listing;
 const before=JSON.stringify(f.j.get(f.task.id));assert.equal(await platform.readback(f.task),null);const saved=f.j.settings(submissionInvestigationKey(f.shopId,f.task.id));
 assert.equal(saved.assessment.classification,'not-found');assert.equal(saved.mode,'title-readback');assert.equal(saved.assessment.currentQueriesComplete,false);assert.equal(JSON.stringify(f.j.get(f.task.id)),before);
});
run('ordinary readback distinguishes inactive null from a query error without touching counters',async f=>{
 const platform=new DoudianPlatform({browser:{test:true},policy:{shopId:f.shopId},journal:f.j,base:'http://127.0.0.1:12345'});platform.list=async()=>f.raw([{...f.campaign,status:'已结束'}]).titleQuery.listing;
 assert.equal(await platform.readback(f.task),null);assert.equal(f.j.settings(submissionInvestigationKey(f.shopId,f.task.id)).assessment.classification,'inactive');
 platform.list=async()=>{throw Object.assign(new Error('temporary disconnect'),{code:'NETWORK_ERROR'});};await assert.rejects(platform.readback(f.task),{code:'NETWORK_ERROR'});
 assert.equal(f.j.settings(submissionInvestigationKey(f.shopId,f.task.id)).assessment.classification,'read-failed');assert.equal(f.j.get(f.task.id).phase,'unknown');assert.equal(f.j.get(f.task.id).submitAttempts,1);assert.equal(f.j.get(f.task.id).riskAttempts,0);
});
run('another shop cannot be queried, reported as this task, or have a diagnostic saved',async f=>{
 const platform=new DoudianPlatform({browser:{test:true,failure:async()=>{}},policy:{shopId:'900002'},journal:f.j,base:'http://127.0.0.1:12345'});let queries=0;platform.list=async()=>{queries++;return f.raw().titleQuery.listing;};
 await assert.rejects(platform.readback(f.task),{code:'SHOP_MISMATCH'});await assert.rejects(platform.investigateSubmission(f.task),{code:'SHOP_MISMATCH'});
 assert.throws(()=>platform.recordSubmissionInvestigation(f.task,f.raw()),{code:'SHOP_MISMATCH'});assert.equal(queries,0);assert.equal(f.j.settings(submissionInvestigationKey(f.shopId,f.task.id)),null);
});
run('changes between independent list reads remain ambiguous rather than being merged into an absence proof',f=>{
 const raw=f.raw();raw.candidateConflicts=[{campaignId:f.campaign.id,before:f.campaign,after:{...f.campaign,status:'已失效'}}];
 const r=adjudicateSubmissionInvestigation(f.task,raw,{now:f.now});assert.equal(r.classification,'ambiguous');assert.equal(r.mayCloseUnknown,false);
});
for(const filter of ['type-select','creator-select','radio','checkbox','tab'])run('an additional rendered filter prevents claiming the complete query scope: '+filter,f=>{
 const query={productId:null,title:f.task.title,status:null},l=f.listing(query);
 for(const s of [l.queryScope.before,l.queryScope.after]){
  if(filter==='type-select')s.selections.push('限时抢购');if(filter==='creator-select')s.selections.push('仅我创建');
  if(['radio','checkbox'].includes(filter))s.selectedFilters=[{kind:filter,label:'只看风险活动'}];if(filter==='tab')s.selectedTabs=['限量抢购'];
 }
 assert.equal(assessSubmissionQuery(l,query,f.task,f.now).complete,false);
});
run('explicit all-types and ordinary pagination size remain compatible with the complete query scope',f=>{
 const query={productId:null,title:f.task.title,status:null},l=f.listing(query);
 for(const s of [l.queryScope.before,l.queryScope.after])s.selections.push('全部活动类型','10 条/页');assert.equal(assessSubmissionQuery(l,query,f.task,f.now).complete,true);
});
