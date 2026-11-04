import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {planOriginalRestore,proveDraft} from '../../src/policy.mjs';
import {submissionInvestigationKey,submissionListFilterSnapshot,officialQuerySurfaceSnapshot} from '../../src/submission-investigation.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const scenario of ['not-found','inactive-sold-out','proven-active','source-disappeared-from-product-filter'])test('native read-only submission investigation: '+scenario,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-submission-investigation-')),limited=scenario==='inactive-sold-out';
 const product=structuredClone(fixtureProducts[0]),fixture=await fixtureServer({catalogProducts:[product,fixtureProducts[1]],limited}),browser=new DedicatedBrowser(dir,{test:true});
 const journal=new Journal(join(dir,'journal.sqlite')),shopId='900001',now=Date.now(),source=fixture.state.campaigns[0];
 if(limited){source.type='限量抢购';source.autoRenew=true;source.products=source.products.map(p=>({...p,activityLimit:1000}));}
 const baseline={source:'verified-platform-history',complete:true,shopId,productId:product.productId,campaignId:source.id,type:limited?'限量抢购':'限时抢购',
  rules:{noLimit:!limited,noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(limited?{autoRenew:true}:{})},durationMs:source.endAt-source.startAt,
  ...(limited?{activityLimit:1000}:{}),observedAt:now,skus:product.skus};journal.remember(baseline,now);
 const plan=planOriginalRestore(baseline,{shopId,productId:product.productId,complete:true,observedAt:now,skus:product.skus},{shopId,originalRiskAllowed:true},now);
 let task=journal.enqueue(shopId,[plan],{complete:true,observedAt:now,lossKey:'native-investigation-'+scenario},now);
 const startAt=Math.floor((now-1000)/1000)*1000,observation={kind:'draft',shopId,title:task.title,type:plan.type,rules:plan.rules,complete:true,observedAt:now,startAt,endAt:startAt+plan.durationMs,
  rows:plan.skus.map(s=>({...s,productId:product.productId})),warnings:[],dialogs:[],...(limited?{productLimits:[{productId:product.productId,activityLimit:1000}]}:{})};
 journal.transition(task.id,'queued','prepared',{},now);journal.beginSubmit(task.id,proveDraft(task,observation,now),now);journal.transition(task.id,'submitting','unknown',{reason:'original response missing'},now);task=journal.get(task.id);
 if(['inactive-sold-out','proven-active'].includes(scenario))fixture.state.campaigns.push({id:'4000000000000000009',name:task.title,type:plan.type,status:limited?'已失效':'进行中',startAt:observation.startAt,endAt:observation.endAt,
  ...(limited?{autoRenew:true}:{}),products:[{...product,...(limited?{activityLimit:1000,soldOut:true}:{})}]});
 if(scenario==='source-disappeared-from-product-filter'){
  source.products=[structuredClone(fixtureProducts[1])];source.risk=true;source.removals=[{productId:product.productId,name:product.name,reason:'价格限制导致退出，需独立核验'}];
 }
 const platform=new DoudianPlatform({browser,journal,policy:{shopId},base:fixture.base});
 const protectedTables=()=>JSON.stringify(Object.fromEntries(['tasks','baselines','price_reviews','price_targets','product_checks'].map(table=>[table,journal.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))),before=protectedTables();
 try{
  if(scenario!=='proven-active'){
   assert.equal(await platform.readback(task),null);const lightweight=journal.settings(submissionInvestigationKey(shopId,task.id));assert.equal(lightweight.mode,'title-readback');assert.equal(lightweight.assessment.classification,limited?'inactive':'not-found');
  }
  const result=await platform.investigateSubmission(task);assert.equal(result.schema,1);assert.equal(result.shopId,shopId);assert.equal(result.taskId,task.id);assert.equal(result.diagnosticOnly,true);
  assert.equal(result.productQueries.length,3);for(const query of result.productQueries){assert.equal(query.listing.complete,true);assert.equal(query.listing.queryScope.verified,true);assert.equal(query.listing.queryScope.unchanged,true);assert.equal(query.listing.shopId,shopId);assert.equal(query.listing.query.productId,product.productId);}
  assert.equal(result.titleQuery.listing.queryScope.verified,true);assert.equal(result.assessment.authorizesSubmit,false);assert.equal(result.assessment.mayCloseUnknown,false);assert.equal(result.assessment.titleScope.dateCoverage.state,'not-observed');
  if(scenario==='inactive-sold-out'){assert.equal(result.assessment.classification,'inactive');assert.equal(result.assessment.detail.products[0].soldOut,true);assert.equal(result.assessment.detail.products[0].activityLimit,1000);assert.equal(result.assessment.detail.rules.autoRenew,true);}
  else if(scenario==='proven-active'){assert.equal(result.assessment.classification,'proven-active');assert.equal(result.assessment.receipt.skuCount,10);assert.equal(result.assessment.observation.startAt,observation.startAt-observation.startAt%1000);}
  else{assert.equal(result.assessment.classification,'not-found');assert.equal(result.assessment.currentQueriesComplete,true);assert.equal(result.assessment.currentProductCandidates,false);}
  if(scenario==='source-disappeared-from-product-filter'){
   assert.ok(result.referenceQueries.some(q=>q.lookup==='exact-source-id-in-full-list'&&q.sourceCampaignId===source.id&&q.listing.queryScope.verified));
   const detail=result.details.find(d=>d.campaignId===source.id);assert.equal(detail.detail.removalExport.records[0].productId,product.productId);assert.equal(detail.detail.removalExport.source,'live-platform-removal-export');
  }else assert.ok(result.referenceQueries.some(q=>q.lookup==='present-in-product-query'&&q.sourceCampaignId===source.id));
  assert.equal(protectedTables(),before);assert.equal(journal.get(task.id).phase,'unknown');assert.equal(journal.get(task.id).submitAttempts,1);assert.equal(journal.get(task.id).riskAttempts,0);
  assert.equal(fixture.state.creates,0);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.risks,0);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.cancelAttempts,undefined);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','submission-investigation-native-'+scenario+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,allFinancialFieldsUnchanged:true,result,financialClicks:0},null,2),'utf8');
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('rendered query snapshot reads only recognized public controls and never secret or hidden values',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-query-snapshot-')),browser=new DedicatedBrowser(dir,{test:true});
 try{
  await browser.open('900001');const page=await browser.page();await page.setContent('<form><input placeholder="请输入商品ID" value="300001"><input placeholder="请输入活动名称" value="守护2-test"><div class="ecom-mcenter-form-item"><label>活动状态</label><div class="ecom-mcenter-select"><div class="ecom-mcenter-select-selection-item">全部</div></div></div><input placeholder="开始日期" value="2026/11/01"><input placeholder="结束日期" value="2026/11/04"><label><input type="checkbox" checked>只看风险活动</label><div role="tab" aria-selected="true">限量抢购</div><button type="button">查询</button><button type="button">重置</button></form><input type="hidden" value="do-not-export-hidden"><input type="password" value="do-not-export-password"><input placeholder="手机号" value="do-not-export-phone"><script>window.changed=0;document.addEventListener("input",()=>window.changed++);document.addEventListener("click",()=>window.changed++);</script>');
  const querySurface=await page.evaluate(officialQuerySurfaceSnapshot),result=await page.evaluate(submissionListFilterSnapshot,{querySurface});assert.equal(querySurface.complete,true);assert.deepEqual(result.productIds,['300001']);assert.deepEqual(result.titles,['守护2-test']);assert.equal(result.dateControls.length,2);assert.deepEqual(result.selectedFilters,[{kind:'checkbox',label:'只看风险活动'}]);assert.deepEqual(result.selectedTabs,['限量抢购']);assert.doesNotMatch(JSON.stringify(result),/do-not-export/);assert.equal(await page.evaluate(()=>window.changed),0);await page.close();
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
