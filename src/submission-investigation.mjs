import {fingerprint,proveReadback,requireThat} from './policy.mjs';
export {officialQuerySurfaceSnapshot,officialQueryCoverage} from './official-query-coverage.mjs';

// Investigation is diagnostic evidence. It never authorizes another submit,
// marks the old request failed, or changes a task, price, quota or grant.
export const submissionInvestigationKey=(shopId,taskId)=>'submission-investigation:'+shopId+':'+taskId;
const active=c=>['进行中','未开始'].includes(c?.status);
export const SUBMISSION_QUERY_FRESH_MS=120000;
export const SUBMISSION_INVESTIGATION_HISTORY_MS=600000;
export const submissionTaskFingerprint=task=>fingerprint({id:task.id,shopId:task.shopId,title:task.title,
 plans:task.plans,createdAt:task.createdAt,submittedAt:task.submittedAt||null,riskAttemptedAt:task.riskAttemptedAt||null,
 submitAttempts:task.submitAttempts,riskAttempts:task.riskAttempts,draftProof:task.draftProof||null,riskProof:task.riskProof||null,receipt:task.receipt||null});

// Runs in the dedicated list page. Read only recognized, rendered query
// controls; never enumerate hidden inputs, browser storage or request data.
export function submissionListFilterSnapshot({querySurface=null}={}){
 const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),text=e=>(e?.innerText||e?.textContent||'').trim();
 const inputs=[...document.querySelectorAll('input')].filter(visible),values=placeholder=>inputs.filter(e=>e.placeholder===placeholder).map(e=>e.value.trim());
 // The overview has empty start/end inputs too. Only the separately captured
 // bounded activity query region may contribute activity-date controls.
 const dates=querySurface?.complete===true&&Array.isArray(querySurface.queryRegion?.dateControls)?
  querySurface.queryRegion.dateControls.filter(e=>e.region==='activity-list-query').map(e=>({placeholder:e.placeholder||'',value:e.value})):[];
 const selections=[...document.querySelectorAll('.ecom-mcenter-select-selection-item')].filter(visible).map(text);
 const selectedFilters=querySurface?.complete===true?querySurface.queryRegion.selectedExtras.map(e=>({kind:e.type,label:e.label})):
  inputs.filter(e=>['radio','checkbox'].includes(e.type)&&e.checked).map(e=>({kind:e.type,label:text(e.closest('label')).slice(0,200)}));
 const selectedTabs=querySurface?.complete===true?querySurface.queryRegion.tabs.filter(e=>e.selected).map(e=>e.label):
  [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible).map(e=>text(e).slice(0,200));
 return{source:'rendered-list-query-controls',observedAt:Date.now(),pathname:location.pathname,
  productIds:values('请输入商品ID'),titles:values('请输入活动名称'),selections,dateControls:dates,selectedFilters,selectedTabs,querySurface};
}
const filterMaterial=s=>s?{source:s.source,pathname:s.pathname,productIds:s.productIds,titles:s.titles,selections:s.selections,dateControls:s.dateControls,
 selectedFilters:s.selectedFilters||[],selectedTabs:s.selectedTabs||[],querySurface:s.querySurface||null}:null;
export function submissionQueryScope({shopId,query,before,after,pages}){
 const unchanged=!!before&&!!after&&fingerprint(filterMaterial(before))===fingerprint(filterMaterial(after));
 const unrecognizedSelections=(after?.selections||[]).filter(s=>s!==(query.status||'全部')&&!/^(?:全部活动类型|全部类型|全部活动|\d+(?:条|个|件)\/页)$/.test(s.replace(/\s/g,'')));
 const extraFilters=(after?.selectedFilters||[]).length>0||(after?.selectedTabs||[]).some(s=>!/^(?:全部|全部活动|全部类型)$/.test(s.replace(/\s/g,'')));
 const status=query.status||'全部',verified=unchanged&&after.source==='rendered-list-query-controls'&&after.pathname==='/ffa/marketing/tools/limitsales'&&
  after.productIds?.length===1&&after.productIds[0]===(query.productId||'')&&after.titles?.length===1&&after.titles[0]===(query.title||'')&&after.selections?.filter(s=>s===status).length===1&&
  Array.isArray(before.selectedFilters)&&Array.isArray(after.selectedFilters)&&Array.isArray(before.selectedTabs)&&Array.isArray(after.selectedTabs)&&unrecognizedSelections.length===0&&!extraFilters;
 return{source:'live-platform-list-query-scope',shopId,verified,unchanged,pages,before,after,unrecognizedSelections,extraFilters};
}
function dateCoverage(listing,task){
 const controls=listing?.queryScope?.after?.dateControls;
 if(!Array.isArray(controls))return{state:'unproven',reason:'未保存日期筛选控件，不能证明查询覆盖提交时间。'};
 if(!controls.length)return{state:'not-observed',reason:'本次页面未观察到日期筛选控件；未将此解释为历史全日期覆盖。'};
 if(controls.length!==2||controls.filter(c=>/开始|起始/.test(c.placeholder)).length!==1||controls.filter(c=>/结束|截止/.test(c.placeholder)).length!==1)return{state:'unproven',reason:'日期筛选不是可唯一识别的起止两端。'};
 const ordered=[controls.find(c=>/开始|起始/.test(c.placeholder)),controls.find(c=>/结束|截止/.test(c.placeholder))];
 if(ordered.every(c=>c.value===''))return{state:'unbounded-visible',coversSubmission:true,reason:'已观察到日期筛选为空。'};
 const parse=(value,end)=>{const m=String(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);if(!m)return null;
  const pad=n=>String(n).padStart(2,'0'),civil=`${m[1]}-${pad(m[2])}-${pad(m[3])}T${m[4]?pad(m[4])+':'+m[5]+':'+(m[6]||'00'):end?'23:59:59':'00:00:00'}`,at=Date.parse(civil+'+08:00');
  return Number.isFinite(at)&&new Date(at+8*3600000).toISOString().slice(0,19)===civil?at:null;};
 const start=parse(ordered[0].value,false),end=parse(ordered[1].value,true),at=task.submittedAt||task.createdAt;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isFinite(at))return{state:'unproven',reason:'日期范围或提交时刻尚未完整解析。'};
 return{state:'bounded',startAt:start,endAt:end,coversSubmission:start<=at&&at<=end,reason:start<=at&&at<=end?'可见日期范围覆盖本次提交时刻。':'可见日期范围未覆盖本次提交时刻。'};
}
export function assessSubmissionQuery(listing,query,task,now=Date.now(),{maxAgeMs=SUBMISSION_QUERY_FRESH_MS,minObservedAt=null}={}){
 const scope=listing?.queryScope,checkedScope=scope&&submissionQueryScope({shopId:task.shopId,query,before:scope.before,after:scope.after,pages:scope.pages});
 const issues=[],fail=(code,reason)=>issues.push({code,reason}),ageMs=Number.isFinite(listing?.observedAt)?now-listing.observedAt:null;
 if(!listing)fail('QUERY_NOT_READ','本次尚未读取该查询，不能把缺失数据视为没有活动。');
 else{
  if(listing.complete!==true)fail('QUERY_INCOMPLETE','该活动查询尚未完整读取所有结果页。');
  if(listing.shopId!==task.shopId||scope?.shopId!==task.shopId)fail('QUERY_SHOP_MISMATCH','该查询记录的店铺与原任务不一致。');
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>SUBMISSION_INVESTIGATION_HISTORY_MS)fail('QUERY_TIME_POLICY_INVALID','查询时效边界无效，未扩大核验期限。');
  else if(!Number.isSafeInteger(listing.observedAt)||listing.observedAt<=0||listing.observedAt>now+5000)fail('QUERY_TIME_UNPROVEN','该查询缺少可信的实际读取时刻。');
  else if(Number.isSafeInteger(minObservedAt)&&listing.observedAt<minObservedAt)fail('QUERY_OUTSIDE_INVESTIGATION','该查询读取早于本轮调查，不能沿用为本轮证据。');
  else if(ageMs>maxAgeMs)fail('QUERY_EXPIRED',`该查询已读取 ${Math.ceil(ageMs/1000)} 秒，超过本项 ${maxAgeMs/1000} 秒核验期限；需要重新读取。`);
  if(!listing.query||fingerprint(listing.query)!==fingerprint(query))fail('QUERY_VALUE_CHANGED','查询商品、活动标题或状态与本次要求不一致。');
  if(scope?.verified!==true||scope.unchanged!==true||checkedScope?.verified!==true)fail('QUERY_FILTER_UNPROVEN','查询前后筛选控件未完整对应，或仍有额外活动类型、创建人等限制。');
  if(!Number.isSafeInteger(scope?.pages)||scope.pages<1)fail('QUERY_PAGES_UNPROVEN','未保存本次完整分页读取记录。');
  if(!Array.isArray(listing.campaigns)||!listing.campaigns.every(c=>typeof c.id==='string'&&c.id.length&&['进行中','未开始','已结束','已失效','已作废'].includes(c.status)&&(!query.status||c.status===query.status))||new Set(listing.campaigns.map(c=>c.id)).size!==listing.campaigns.length)fail('QUERY_RESULTS_UNPROVEN','活动结果包含重复身份、未识别状态或与所选状态不一致的记录。');
 }
 return{complete:issues.length===0,code:issues[0]?.code||'QUERY_COMPLETE',issues,ageMs,maxAgeMs,observedAt:listing?.observedAt||null,query,dateCoverage:dateCoverage(listing,task),reason:issues[0]?.reason||'已完整读取且复核本次查询控件。'};
}
export function submissionReadbackObservation(task,campaign,detail){
 return{complete:detail.complete,shopId:task.shopId,title:campaign.name,campaignId:campaign.id,status:campaign.status,
  observedAt:detail.observedAt,type:campaign.type,rules:detail.rules,rows:detail.products.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),startAt:campaign.startAt,endAt:campaign.endAt,
  ...(campaign.type==='限量抢购'?{productLimits:detail.products.map(p=>({productId:p.productId,activityLimit:p.activityLimit}))}:{})};
}
export function makeSubmissionInvestigation(task,{mode='complete-investigation',startedAt,finishedAt,titleListing=null,titleError=null,details=[],productQueries=[],referenceQueries=[],candidateConflicts=[],initialTitleQuery=null,initialProductQueries=[],error=null}={}){
 requireThat(task?.id&&task.shopId&&task.title&&task.plans?.length,'INVESTIGATION_TASK','提交调查缺少确定任务身份');
 return{schema:1,source:'live-platform-submission-investigation',diagnosticOnly:true,authorizesSubmit:false,mode,
  shopId:task.shopId,taskId:task.id,title:task.title,taskFingerprint:submissionTaskFingerprint(task),startedAt,finishedAt,
  titleQuery:{listing:titleListing,error:titleError},details,productQueries,referenceQueries,candidateConflicts,...(initialTitleQuery?{initialTitleQuery}:{}),...(initialProductQueries.length?{initialProductQueries}:{}),error};
}
export function adjudicateSubmissionInvestigation(task,raw,{now=Date.now()}={}){
 const result=(classification,reason,extra={})=>({classification,reason,diagnosticOnly:true,authorizesSubmit:false,mayCloseUnknown:false,...extra});
 if(raw?.schema!==1||raw.source!=='live-platform-submission-investigation'||raw.shopId!==task?.shopId||raw.taskId!==task?.id||raw.title!==task?.title||
  raw.taskFingerprint!==submissionTaskFingerprint(task))return result('unproven','调查与当前店铺、任务或原提交证明不一致。');
 const historicalFrame=raw.mode==='complete-investigation'&&Number.isSafeInteger(raw.startedAt)&&Number.isSafeInteger(raw.finishedAt)&&raw.startedAt<=raw.finishedAt&&raw.finishedAt<=now+5000&&now-raw.startedAt<=SUBMISSION_INVESTIGATION_HISTORY_MS;
 const listing=raw.titleQuery?.listing,titleQuery={productId:null,title:task.title,status:null},titleScope=assessSubmissionQuery(listing,titleQuery,task,now,{maxAgeMs:historicalFrame?SUBMISSION_INVESTIGATION_HISTORY_MS:SUBMISSION_QUERY_FRESH_MS,minObservedAt:historicalFrame?raw.startedAt:null}),matches=(listing?.campaigns||[]).filter(c=>c.name===task.title);
 const products=(task.plans||[]).map(plan=>({productId:plan.productId,statuses:['进行中','未开始'].map(status=>{
  const query=raw.productQueries?.find(q=>q.productId===plan.productId&&q.status===status),scope=assessSubmissionQuery(query?.listing,{productId:plan.productId,title:null,status},task,now,{minObservedAt:raw.startedAt});
  return{status,...scope,error:query?.error||null,campaignIds:query?.listing?.campaigns?.map(c=>c.id)||[]};})}));
 const context={titleScope,products,matchedCampaignIds:matches.map(c=>c.id)};
 if(raw.error||raw.titleQuery?.error)return result('read-failed','本次只读调查未完成：'+(raw.error?.message||raw.titleQuery.error.message||'读取失败'),context);
 if(!titleScope.complete)return result('unproven',titleScope.reason,context);
 if(raw.candidateConflicts?.length)return result('ambiguous','独立查询之间活动状态或身份发生变化，保留各次读数，不能合并为定案证据。',{...context,candidateConflicts:raw.candidateConflicts});
 if(matches.length>1)return result('ambiguous','出现多个完全同名活动，不能选择其中一个认定原提交结果。',context);
 if(matches.length===1){
  const campaign=matches[0],entry=raw.details?.find(d=>d.campaignId===campaign.id),detail=entry?.detail;
  if(!active(campaign))return result('inactive','已找到完全同名的非当前活动；'+(entry?.shopId===task.shopId&&detail?.complete?'保留实际来源、售罄及退出明细。':'详情、售罄及退出明细仍需读取。')+'尚未认定旧提交失败或允许补量。',{...context,campaign,...(entry?.shopId===task.shopId?{detail}:{}),detailError:entry?.error||null});
  const currentTitle=assessSubmissionQuery(listing,titleQuery,task,now,{minObservedAt:raw.startedAt});
  if(!currentTitle.complete)return result('unproven','同名活动当前状态还需新鲜读取：'+currentTitle.reason,{...context,currentTitle,campaign});
  if(entry?.shopId!==task.shopId||entry?.error||!detail?.complete)return result('read-failed','已找到同名活动，但完整详情尚未核实。',{...context,campaign});
  if(detail.products.some(p=>p.removalConfirmed||p.removalAmbiguous))return result('proof-mismatch','同名活动存在退出或状态不明确的商品，不能记为恢复成功。',{...context,campaign,detail});
  try{const observation=submissionReadbackObservation(task,campaign,detail),receipt=proveReadback(task.plans,observation,{title:task.title,now,expectedRange:task.draftProof?.observation||null});
   return result('proven-active','已独立读取唯一同名有效活动，全部规格、价格、规则及原提交时段一致。',{...context,campaign,observation,receipt});
  }catch(error){return result('proof-mismatch','同名有效活动与原提交证明尚未完整对应：'+error.message,{...context,campaign,proofError:{code:error.code||'ERROR',message:error.message}});}
 }
 const allCurrentQueries=products.every(p=>p.statuses.every(s=>s.complete&&!s.error)),someCandidate=products.some(p=>p.statuses.some(s=>s.campaignIds.length));
 const incomplete=products.flatMap(p=>p.statuses.filter(s=>!s.complete||s.error).map(s=>`${p.productId} ${s.status}：${s.error?.message||s.reason}`));
 return result('not-found',allCurrentQueries?someCandidate?'精确标题未找到；商品查询有其他活动候选，必须逐项核实归属，不能重提。':'精确标题及两种当前状态商品查询均无候选；这只表示本次查询未找到，不能证明历史提交失败或自行解除未知。':'精确标题未找到，当前归属核验尚未完成：'+incomplete.join('；')+'保留未知并继续核查。',{
  ...context,currentQueriesComplete:allCurrentQueries,currentProductCandidates:someCandidate});
}
