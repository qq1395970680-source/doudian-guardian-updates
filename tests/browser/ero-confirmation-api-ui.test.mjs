import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {createApp} from '../../src/server.mjs';
import {fingerprint} from '../../src/policy.mjs';
import {eroDualProposalFixture} from '../helpers/ero-dual-proposal-fixture.mjs';
import {dualDraftObservation} from '../helpers/dual-activity-fixture.mjs';
import {openPriceWorkspace,closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';

const cto='5500000000000000103',targetState=j=>fingerprint({tasks:j.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(),targets:j.db.prepare('SELECT * FROM price_targets ORDER BY rowid').all(),approved:j.db.prepare("SELECT body FROM price_reviews WHERE state='approved' ORDER BY rowid").all()});
async function fixture(width,{expired=false}={}){
 const root=await mkdtemp(join(tmpdir(),'guardian-ero-confirmation-smoke-')),journal=new Journal(':memory:'),f=eroDualProposalFixture(journal,{now:Date.now()-(expired?121000:0)}),calls=[],financial=[];
 f.platform.probe=async()=>({shopId:f.policy.shopId,name:'ERO API界面隔离验收'});
 f.platform.loss=async()=>({...structuredClone(f.loss),observedAt:Date.now(),removalEvidence:{...structuredClone(f.loss.removalEvidence),observedAt:Date.now()}});
 f.platform.precheck=async b=>({...structuredClone(b),complete:true,offShelf:false,observedAt:Date.now()});
 f.platform.priceCheck=async task=>{calls.push(task.plans[0].type);return dualDraftObservation(task,{now:Date.now(),errorsById:{[cto]:['单品活动价￥210.56，需≤￥112']}});};
 for(const name of ['prepare','submit','confirmOriginalRisk','resumeOriginalRisk','cancel','cancelCampaign'])f.platform[name]=async()=>{financial.push(name);assert.fail('This API/UI smoke cannot enter '+name);};
 const service=new GuardianService({journal,platform:f.platform,policy:f.policy,immediate:false}),app=await createApp({config:f.policy,runtime:root,port:0,dependencies:{journal,service,platform:f.platform,browser:{close:async()=>{}}}}),html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
 const post=(path,args)=>fetch(app.url+'/api/'+path,{method:'POST',headers,body:JSON.stringify(args)}),get=async path=>{const response=await fetch(app.url+'/api/'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
 await post('finish-login',{});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.snapshot().connection.shopId,f.policy.shopId);
 const browser=new DedicatedBrowser(join(root,'isolated-headless-ui'),{test:true,viewport:{width,height:1050}});await browser.open(f.policy.shopId);const page=await browser.page();page.setDefaultTimeout(12000);const errors=[],posts=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});await page.goto(app.url);
 return{...f,root,journal,service,app,browser,page,post,get,calls,financial,errors,posts,async close(){await browser.close();await app.close();await rm(root,{recursive:true,force:true});}};
}
async function artifact(x,name,extra){const root=resolve('artifacts','ero-confirmation-api-ui');await mkdir(root,{recursive:true});await x.page.screenshot({path:join(root,name+'.png'),fullPage:false});await writeFile(join(root,name+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,nativeUi:true,realApi:true,noDtoInterception:true,errors:x.errors,posts:x.posts,financialEntries:x.financial,...extra},null,2),'utf8');}

test('ERO exact timed consent returns real 202, preserves the approved target, and can be withdrawn from the native drawer',{timeout:90000},async()=>{
 const x=await fixture(1440);try{
  const before=targetState(x.journal),product=x.baseline.productId,detail=await x.get('price-reviews/item?productId='+product),r=detail.review,option=r.options.find(o=>o.available&&o.activityType==='限时抢购'&&o.id==='original');
  assert.equal(detail.approvalAllowed,true);assert.equal(detail.comparison.find(s=>s.type==='限量抢购').candidateReady,false);assert.ok(option);assert.equal(option.rows.find(s=>s.id===cto).saleFen,11200);assert.equal(x.target.rows.find(s=>s.id===cto).saleFen,21056);assert.ok(r.options.filter(o=>o.activityType==='限量抢购').every(o=>!o.available));
  const args={shopId:r.shopId,reviewId:r.id,key:r.key,decision:'approve',dualPairKey:r.dualPairKey,optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:option.rows.map(s=>s.id)};
  for(const mutation of [{acceptPriceAndRisk:false},{confirmedSkuIds:args.confirmedSkuIds.slice(1)},{dualPairKey:'stale-pair'},{optionId:'switch-original',optionKey:'cannot-select-unproven-limited'}]){const rejected=await x.post('price-reviews/decide',{...args,...mutation});assert.equal(rejected.status,400,await rejected.text());assert.equal(targetState(x.journal),before);assert.equal(x.service.priceApprovalIntent(product),null);}
  const dialog=await openPriceWorkspace(x.page,product);await dialog.locator('table[data-role="price-target-table"]').waitFor();assert.equal(await dialog.locator('tbody tr').count(),5);
  assert.match(await dialog.locator('[data-target-price="'+cto+'"]').innerText(),/112\.00/);assert.match(await dialog.locator('table').innerText(),/210\.56/);
  const approve=dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}),checkbox=dialog.locator('.price-consent input');assert.equal(await checkbox.isChecked(),false);assert.equal(await approve.isDisabled(),true);
  assert.equal(await dialog.locator('[data-activity-price-type="限量抢购"] [data-activity-price-choice]:enabled').count(),0);await artifact(x,'1440-exact-prices-before-consent',{targetUnchanged:targetState(x.journal)===before});
  await checkbox.check();const responsePromise=x.page.waitForResponse(response=>response.url().endsWith('/api/price-reviews/decide')&&response.request().method()==='POST');await approve.click();const response=await responsePromise,queued=await response.json();assert.equal(response.status(),202);assert.equal(queued.queued,true);assert.equal(queued.state,'pending-revalidation');assert.equal(queued.review,undefined);
  await dialog.locator('[data-cancel-price-confirmation]').waitFor();assert.match(await dialog.innerText(),/已收到确切价格确认|正在重新核验/);assert.equal(x.service.priceApprovalIntent(product).state,'pending');assert.equal(x.service.priceApprovalIntent(product).intent.desired.rows.find(s=>s.id===cto).saleFen,11200);assert.equal(targetState(x.journal),before);assert.deepEqual(x.calls,[]);
  const pendingDetail=await x.get('price-reviews/item?productId='+product);assert.equal(pendingDetail.approvalAllowed,false);assert.equal(pendingDetail.readOnly,true);assert.equal(pendingDetail.pendingPriceApproval.id,queued.intentId);
  assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).count(),0);await artifact(x,'1440-pending-revalidation',{status:response.status(),queued,targetUnchanged:targetState(x.journal)===before});
  const cancellation=x.page.waitForResponse(response=>response.url().endsWith('/api/price-reviews/cancel-confirmation')&&response.request().method()==='POST');await dialog.locator('[data-cancel-price-confirmation]').click();const cancelled=await cancellation;assert.equal(cancelled.status(),200);assert.equal((await cancelled.json()).cancelled,true);assert.equal(x.service.priceApprovalIntent(product).state,'cancelled');
  await x.service.revalidateExactPriceIntent(x.baseline);assert.deepEqual(x.calls,[]);assert.equal(targetState(x.journal),before);assert.equal((await x.post('price-reviews/cancel-confirmation',{shopId:r.shopId,productId:product,intentId:queued.intentId})).status,400);
  await closePriceWorkspace(x.page);await x.page.locator('[data-workspace-scope="history"]').click();await x.page.locator('[data-open-price-review="'+product+'"]').first().click();await dialog.locator('[data-review-id="'+x.target.id+'"]').waitFor();assert.equal(await dialog.locator('.price-consent input,[data-manual-sku],[data-cancel-price-confirmation]').count(),0);
  await artifact(x,'1440-cancelled-history-read-only',{intentState:x.service.priceApprovalIntent(product).state,targetUnchanged:targetState(x.journal)===before});assert.deepEqual(x.errors,[]);assert.deepEqual(x.financial,[]);assert.equal(x.state.submits,0);
 }finally{await x.close();}
});

test('expired ERO price suggestions disappear from confirmation and stay non-financial in the 960px native UI',{timeout:60000},async()=>{
 const x=await fixture(960,{expired:true});try{
  const before=targetState(x.journal),product=x.baseline.productId,expired=x.journal.priceReviews(x.policy.shopId).find(r=>r.status==='pending'),list=await x.get('recovery-workspace?scope=confirm');assert.equal(list.total,0);assert.equal((await x.get('recovery-workspace?scope=automatic')).total,1);
  const detail=await x.get('price-reviews/item?productId='+product);assert.equal(detail.approvalAllowed,false);assert.equal(detail.readOnly,true);assert.equal(detail.review.id,x.target.id);assert.equal(detail.review.options,undefined);assert.equal((await fetch(x.app.url+'/api/price-reviews/item?productId='+product+'&reviewId='+expired.id)).status,400);
  await x.page.locator('[data-view="workspace"]').click();await x.page.locator('[data-workspace-scope="confirm"]').click();await x.page.getByText('当前没有需要你确认的降价',{exact:true}).waitFor();assert.equal(await x.page.locator('#price-reviews [data-open-price-review]').count(),0);await artifact(x,'960-expired-confirmation-hidden',{confirmCount:list.total,targetUnchanged:targetState(x.journal)===before});
  const dialog=await openPriceWorkspace(x.page,product,{scope:'automatic'});assert.equal(await dialog.locator('.price-consent input,[data-manual-sku]').count(),0);assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).count(),0);assert.match(await dialog.locator('[data-target-price="'+cto+'"]').innerText(),/210\.56/);assert.equal(await x.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await artifact(x,'960-expired-only-current-approved-price',{displayedReview:detail.review.id,targetUnchanged:targetState(x.journal)===before});assert.deepEqual(x.posts,[]);assert.deepEqual(x.errors,[]);assert.deepEqual(x.financial,[]);assert.equal(targetState(x.journal),before);
 }finally{await x.close();}
});
