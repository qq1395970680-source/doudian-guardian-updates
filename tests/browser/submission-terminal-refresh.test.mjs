import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fingerprint,planOriginalRestore,proveDraft} from '../../src/policy.mjs';
import {adjudicateSubmissionInvestigation} from '../../src/submission-investigation.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const financialTables=['tasks','baselines','price_reviews','price_targets','product_checks','submission_archives','submission_successors'];
const financialSnapshot=j=>Object.fromEntries(financialTables.map(table=>[table,j.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
async function fixture({campaignCount=1,missingRecordedLimited=false}={}){
 const root=await mkdtemp(join(tmpdir(),'guardian-terminal-refresh-')),product=structuredClone(fixtureProducts[0]),server=await fixtureServer({catalogProducts:[product],detailObservedPrices:true}),browser=new DedicatedBrowser(join(root,'browser'),{test:true}),journal=new Journal(join(root,'guardian.sqlite')),shopId='900001',now=Date.now();
 server.state.campaigns=Array.from({length:campaignCount},(_,i)=>{const startAt=Math.floor((now-(i+5)*86400000)/1000)*1000;return{id:String(4000000000000000001n+BigInt(i)),name:'独立历史活动-'+i,type:'限时抢购',status:'已结束',startAt,endAt:startAt+48*3600000,products:[structuredClone(product)]};});
 const recordedSourceId='4000000000000000099',removal={productId:product.productId,name:product.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'};
 if(missingRecordedLimited){const startAt=Math.floor((now-5*86400000)/1000)*1000;server.state.campaigns.push({id:recordedSourceId,name:'真实绑定的限量退出来源',type:'限量抢购',status:'已失效',autoRenew:true,risk:true,startAt,endAt:startAt+7*86400000,products:[{...structuredClone(product),activityLimit:1000,soldOut:false,removalConfirmed:true}],removals:[removal]});
  await browser.open(shopId);await browser.context.route('**/ffa/marketing/tools/limitsales',async route=>{const response=await route.fetch(),html=await response.text(),filter='c.products.some(p=>p.productId===q)';assert.ok(html.includes(filter));await route.fulfill({response,body:html.replace(filter,'(c.id!=='+JSON.stringify(recordedSourceId)+'&&'+filter+')')});});
 }
 const source=server.state.campaigns[0],baseline={source:'verified-platform-history',complete:true,shopId,productId:product.productId,campaignId:source.id,type:'限时抢购',durationMs:48*3600000,rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:product.skus};journal.remember(baseline,now);
 const plan=planOriginalRestore(baseline,{shopId,productId:product.productId,complete:true,observedAt:now,skus:product.skus},{shopId,originalRiskAllowed:true},now);
 let task=journal.enqueue(shopId,[plan],{complete:true,observedAt:now,lossKey:'terminal-refresh-read-only-fixture',...(missingRecordedLimited?{priceRules:[{removal,removalEvidence:{source:'live-platform-removal-export',shopId,campaignId:recordedSourceId,activityType:'限量抢购',complete:true,observedAt:now,sha256:'a'.repeat(64),record:removal}}]}:{})},now);
 const startAt=Math.floor((now-1000)/1000)*1000,observation={kind:'draft',shopId,title:task.title,type:plan.type,rules:plan.rules,complete:true,observedAt:now,startAt,endAt:startAt+plan.durationMs,rows:plan.skus.map(s=>({...s,productId:product.productId})),warnings:[],dialogs:[]};
 journal.transition(task.id,'queued','prepared',{},now);journal.beginSubmit(task.id,proveDraft(task,observation,now),now);
 if(missingRecordedLimited)journal.beginRiskConfirmation(task.id,{taskId:task.id,kind:'original-discount-risk',at:now,observation:{...observation,dialogs:[`1 个商品存在低价风险，请谨慎新建 ID：${product.productId} 预估最低到手价 仍要创建`]}},now);
 journal.transition(task.id,'submitting','unknown',{reason:'Original response remains unknown'},now);task=journal.get(task.id);
 const platform=new DoudianPlatform({browser,journal,policy:{shopId},base:server.base}),forbidden=[];
 for(const name of ['prepare','submit','confirmOriginalRisk','resumeOriginalRisk','resumeRisk','cancel','cancelCampaign','cancelProducts','cancelProduct','completeCancellation','beforeSubmit','beforeRisk','assertWrite'])platform[name]=()=>{forbidden.push(name);assert.fail('Read-only investigation reached financial entry point '+name);};
 const before=financialSnapshot(journal),beforeTask=fingerprint(task),calls=[],nativeList=platform.list.bind(platform);platform.list=async query=>{const read={query:structuredClone(query),startedAt:Date.now()};calls.push(read);try{const result=await nativeList(query);read.observedAt=result.observedAt;read.complete=result.complete;return result;}catch(error){read.error={code:error.code||'READ_ERROR',message:error.message};throw error;}finally{read.finishedAt=Date.now();}};
 const unchanged=()=>{assert.deepEqual(financialSnapshot(journal),before);assert.equal(fingerprint(journal.get(task.id)),beforeTask);assert.deepEqual(forbidden,[]);for(const name of ['creates','submits','risks','uploads'])assert.equal(server.state[name],0,name);assert.equal(server.state.cancelAttempts,undefined);};
 return{root,server,browser,journal,platform,task,product,calls,recordedSourceId,unchanged,before,async close(){await browser.close();journal.close();await server.close();await rm(root,{recursive:true,force:true});}};
}
async function evidence(name,value){await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',name),JSON.stringify(value,null,2),'utf8');}

test('native 44-history investigation genuinely exceeds two minutes, then replaces only canonical reads with fresh terminal observations',{timeout:300000},async()=>{
 const f=await fixture({campaignCount:44,missingRecordedLimited:true}),nativeDetail=f.platform.detail.bind(f.platform);let inFlight=0,maximum=0,detailCalls=0;const detailReads=[];
 f.platform.detail=async campaign=>{const read={campaignId:campaign.id,startedAt:Date.now()};detailReads.push(read);detailCalls++;inFlight++;maximum=Math.max(maximum,inFlight);try{await wait(8000);const result=await nativeDetail(campaign);read.observedAt=result.observedAt;assert.equal(result.complete,true);assert.equal(result.products[0].skus.length,10);return result;}finally{read.finishedAt=Date.now();inFlight--;}};
 try{
  const result=await f.platform.investigateSubmission(f.task),finishedAt=result.finishedAt;
  assert.ok(finishedAt-result.startedAt>120000,'Use real wall time; no patched clock or fabricated observation times');
  assert.equal(detailCalls,46);assert.equal(result.details.length,45);assert.equal(f.server.state.detailLoads,46);assert.equal(maximum,3);assert.equal(inFlight,0);
  assert.ok(result.details.every(d=>d.shopId===f.task.shopId&&d.detail.complete&&!d.error));
  assert.ok(finishedAt-result.initialTitleQuery.listing.observedAt>120000,'Original title really aged during historical detail reads');
  const initialCurrent=result.initialProductQueries.find(q=>q.status==='进行中'),initialUpcoming=result.initialProductQueries.find(q=>q.status==='未开始');
  assert.ok(finishedAt-initialCurrent.listing.observedAt>120000,'Original current query really expired');
  assert.equal(result.productQueries.length,3);assert.equal(result.productQueries.filter(q=>q.status===null).length,1);
  for(const status of ['进行中','未开始']){const current=result.productQueries.find(q=>q.status===status),initial=status==='进行中'?initialCurrent:initialUpcoming;
   assert.equal(current.error,null);assert.equal(current.listing.complete,true);assert.equal(current.listing.shopId,f.task.shopId);assert.equal(current.listing.queryScope.verified,true);assert.equal(current.listing.queryScope.unchanged,true);
   assert.ok(current.listing.observedAt>initial.listing.observedAt);assert.ok(finishedAt-current.listing.observedAt<120000);assert.deepEqual(current.listing.campaigns,[]);
  }
  assert.ok(result.titleQuery.listing.observedAt>result.initialTitleQuery.listing.observedAt);assert.ok(finishedAt-result.titleQuery.listing.observedAt<120000);
  assert.equal(result.titleQuery.listing.queryScope.verified,true);assert.deepEqual(result.titleQuery.listing.campaigns,[]);
  assert.equal(result.initialProductQueries.find(q=>q.status===null).listing.campaigns.length,44);assert.ok(!result.initialProductQueries.some(q=>q.listing.campaigns.some(c=>c.id===f.recordedSourceId)),'The actual removed source is genuinely omitted from product-filtered DOM results');
  const sourceReference=result.referenceQueries.find(r=>r.sourceCampaignId===f.recordedSourceId);assert.equal(sourceReference.referenceKind,'recorded-loss-source');assert.equal(sourceReference.lookup,'exact-source-id-in-full-list');assert.equal(sourceReference.listing.queryScope.verified,true);assert.ok(sourceReference.listing.campaigns.some(c=>c.id===f.recordedSourceId));
  const sourceReads=detailReads.filter(r=>r.campaignId===f.recordedSourceId),source=result.details.find(d=>d.campaignId===f.recordedSourceId);assert.equal(sourceReads.length,2);assert.ok(sourceReads[1].observedAt>sourceReads[0].observedAt);assert.equal(source.detail.observedAt,sourceReads[1].observedAt);assert.ok(finishedAt-source.detail.observedAt<120000);assert.equal(source.campaign.type,'限量抢购');assert.equal(source.detail.products[0].activityLimit,1000);assert.equal(source.detail.products[0].soldOut,false);assert.equal(f.task.plans[0].type,'限时抢购');assert.equal(f.journal.get(f.task.id).riskAttempts,1);
  const assessment=adjudicateSubmissionInvestigation(f.task,result,{now:finishedAt});assert.equal(assessment.classification,'not-found');assert.equal(assessment.currentQueriesComplete,true);assert.equal(assessment.authorizesSubmit,false);assert.equal(assessment.mayCloseUnknown,false);
  assert.equal(result.assessment.classification,'not-found');assert.equal(result.assessment.currentQueriesComplete,true);f.unchanged();
  await evidence('submission-terminal-refresh-long-native.json',{localFixtureOnly:true,headless:true,actualWallClock:true,delayBeforeEachNativeDetailMs:8000,maximumDetailConcurrency:maximum,elapsedMs:finishedAt-result.startedAt,financialTablesExactlyPreserved:true,originalTaskStillUnknown:true,financialEntries:[],financialClicks:0,calls:f.calls,detailReads,result});
 }finally{await f.close();}
});

test('a terminal current-query network failure remains explicit and cannot fall back to the earlier successful query',{timeout:90000},async()=>{
 const f=await fixture(),list=f.platform.list.bind(f.platform);let currentCalls=0,aborted=0;
 f.platform.list=async query=>{if(query.productId===f.product.productId&&query.status==='进行中'&&++currentCalls===2){await f.browser.context.route('**/ffa/marketing/tools/limitsales',route=>{aborted++;return route.abort('failed');},{times:1});}return list(query);};
 try{
  const result=await f.platform.investigateSubmission(f.task),initial=result.initialProductQueries.find(q=>q.status==='进行中'),current=result.productQueries.find(q=>q.status==='进行中');
  assert.equal(currentCalls,2);assert.equal(aborted,1);assert.equal(initial.error,null);assert.equal(initial.listing.complete,true);assert.equal(current.listing,null);assert.ok(current.error?.message);
  assert.equal(result.assessment.currentQueriesComplete,false);assert.equal(result.assessment.authorizesSubmit,false);assert.equal(result.assessment.mayCloseUnknown,false);assert.notEqual(result.assessment.classification,'proven-active');f.unchanged();
  await evidence('submission-terminal-refresh-error-native.json',{localFixtureOnly:true,headless:true,realNetworkAbort:true,financialTablesExactlyPreserved:true,originalTaskStillUnknown:true,financialClicks:0,calls:f.calls,result});
 }finally{await f.close();}
});
