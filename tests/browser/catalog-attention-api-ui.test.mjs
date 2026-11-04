import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {createApp} from '../../src/server.mjs';
import {fingerprint,proveDraft,proveReadback} from '../../src/policy.mjs';
import {eroDualProposalFixture} from '../helpers/ero-dual-proposal-fixture.mjs';
import {dualDraftObservation} from '../helpers/dual-activity-fixture.mjs';

const moneyState=j=>fingerprint(Object.fromEntries(['tasks','baselines','price_reviews','price_targets','submission_archives','submission_successors'].map(t=>[t,j.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])));
async function fixture({mode,width=1440}){
 const dir=await mkdtemp(join(tmpdir(),'guardian-catalog-attention-')),journal=new Journal(':memory:'),now=Date.now(),f=eroDualProposalFixture(journal,{now:now-(mode==='expired'?121000:0)}),productId=f.baseline.productId,shopId=f.policy.shopId;
 if(mode==='verified'){
  await new Promise(r=>setTimeout(r,2));const verifiedAt=Date.now();
  const task=journal.enqueue(shopId,[f.plan],{complete:true,observedAt:verifiedAt,lossKey:'synthetic-new-verified-no-later-loss'},verifiedAt),draft=dualDraftObservation(task,{now:verifiedAt});
  journal.transition(task.id,'queued','prepared',{},verifiedAt);journal.beginSubmit(task.id,proveDraft(task,draft,verifiedAt),verifiedAt);journal.transition(task.id,'submitting','verifying',{},verifiedAt);
  const observed={...draft,kind:'activity',campaignId:'4600000000000000101',status:'进行中'},receipt=proveReadback(task.plans,observed,{title:task.title,now:verifiedAt,expectedRange:draft});journal.transition(task.id,'verifying','verified',{receipt},verifiedAt);
 }
 if(mode==='off-shelf')journal.putProductCheck(shopId,productId,{code:'OFF_SHELF',message:'隔离数据：商品已下架',at:now,retryAt:now+900000,productState:{source:'live-platform-product-management',shopId,productId,complete:true,observedAt:now,kind:'off-shelf',status:'已下架'}});
 if(mode==='excluded'){f.policy.excludedProductIds=[productId];const app=journal.settings('application');app.accounts.find(a=>a.shopId===shopId).excludedProductIds=[productId];journal.putSettings('application',app);}
 const observedAt=mode==='fresh-incomplete'?now:now-6*60000,inventory={listing:{complete:true,observedAt,currentObservedAt:observedAt,campaigns:[]},activeComplete:false,details:new Map()};f.platform.inventory=inventory;
 f.platform.probe=async()=>({shopId,name:'待恢复显示隔离验收'});f.platform.discover=async()=>({activeComplete:false,baselines:[]});const financial=[];
 for(const name of ['prepare','submit','confirmOriginalRisk','resumeOriginalRisk','priceCheck','cancel','cancelCampaign'])f.platform[name]=async()=>{financial.push(name);assert.fail('A display-only test cannot invoke '+name);};
 const service=new GuardianService({journal,platform:f.platform,policy:f.policy,immediate:false}),app=await createApp({config:f.policy,runtime:dir,port:0,dependencies:{journal,service,platform:f.platform,browser:{close:async()=>{}}}}),html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1];
 await fetch(app.url+'/api/finish-login',{method:'POST',headers:{'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url},body:'{}'});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.snapshot().connection.shopId,shopId);
 const get=async path=>{const response=await fetch(app.url+'/api/'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const before=moneyState(journal),browser=new DedicatedBrowser(join(dir,'headless-display'),{test:true,viewport:{width,height:1000}});await browser.open(shopId);const page=await browser.page(),posts=[],errors=[];page.setDefaultTimeout(10000);page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
 return{...f,dir,journal,service,app,browser,page,get,productId,mode,inventory,before,posts,errors,financial,async close(){await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}};
}
async function evidence(x,name,api){const dir=resolve('artifacts','catalog-attention-api-ui');await mkdir(dir,{recursive:true});await x.page.screenshot({path:join(dir,name+'.png'),fullPage:false});await writeFile(join(dir,name+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,realApi:true,noDtoInterception:true,mode:x.mode,financialUnchanged:moneyState(x.journal)===x.before,posts:x.posts,errors:x.errors,financialCalls:x.financial,catalog:api},null,2),'utf8');}
async function waitingTab(x){await x.page.locator('[data-view="overview"]').click();await x.page.locator('[data-filter="missing"]').click();}
function safe(x){assert.equal(moneyState(x.journal),x.before);assert.deepEqual(x.posts,[]);assert.deepEqual(x.errors,[]);assert.deepEqual(x.financial,[]);assert.equal(x.state.submits,0);assert.equal(x.service.priceApprovalIntent(x.productId),null);}

for(const [mode,width] of [['stale',1440],['fresh-incomplete',960]])test('known real two-scheme price work remains in overview waiting recovery despite '+mode,{timeout:60000},async()=>{
 const x=await fixture({mode,width});try{
  const api=await x.get('products'),p=api.products.find(p=>p.productId===x.productId);assert.equal(p.state,'unconfirmed');assert.equal(api.complete,false);assert.equal(api.stale,mode==='stale');assert.equal(api.attention.waitingCount,1);assert.deepEqual(api.attention.waitingProductIds,[x.productId]);assert.equal(p.displayAttention.waiting,true);assert.equal((await x.get('recovery-workspace?scope=confirm')).total,1);
  assert.equal(api.listingObservedAt,x.inventory.listing.currentObservedAt);assert.deepEqual(p.current,[]);assert.deepEqual(p.scheduled,[]);
  await waitingTab(x);const product=x.page.locator('#products [data-product-id="'+x.productId+'"]');await product.waitFor();assert.equal(await x.page.locator('#missing-count').innerText(),'1');assert.equal(await x.page.locator('#products [data-product-id]').count(),1);assert.match(await product.locator(':scope > summary').innerText(),/价格|降价|核验/);assert.equal(await x.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await product.locator(':scope > summary').click();assert.equal(await product.locator('[data-target-price],.price-consent input,[data-manual-sku]').count(),0);assert.doesNotMatch(await product.innerText(),/¥112\.00/);safe(x);await evidence(x,mode+'-'+width,api);
 }finally{await x.close();}
});
test('expired facts keep only the product and verification reason in waiting recovery, never the expired exact quote',{timeout:60000},async()=>{
 const x=await fixture({mode:'expired',width:960});try{
  const api=await x.get('products'),p=api.products.find(p=>p.productId===x.productId);assert.equal(p.displayAttention.waiting,true);assert.equal(api.attention.waitingCount,1);assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);
  const detail=await x.get('price-reviews/item?productId='+x.productId);assert.equal(detail.approvalAllowed,false);assert.equal(detail.review.id,x.target.id);assert.equal(detail.review.options,undefined);
  await waitingTab(x);const product=x.page.locator('#products [data-product-id="'+x.productId+'"]');await product.waitFor();await product.locator(':scope > summary').click();assert.doesNotMatch(await product.innerText(),/¥112\.00/);assert.equal(await product.locator('.price-consent input,[data-manual-sku],[data-target-price]').count(),0);safe(x);await evidence(x,'expired-product-only-960',api);
 }finally{await x.close();}
});
test('a strict newer verified receipt without later loss stays out of waiting while the directory is stale',{timeout:60000},async()=>{
 const x=await fixture({mode:'verified',width:1440});try{
  const api=await x.get('products'),p=api.products.find(p=>p.productId===x.productId);assert.equal(p.state,'unconfirmed');assert.equal(api.stale,true);assert.equal(api.attention.waitingCount,0);assert.ok(api.attention.readbackProductIds.includes(x.productId));assert.equal(p.displayAttention.waiting,false);
  await waitingTab(x);await x.page.waitForFunction(()=>document.querySelector('#missing-count').textContent==='0');assert.equal(await x.page.locator('#products [data-product-id="'+x.productId+'"]').count(),0);
  await x.page.locator('[data-filter="all"]').click();const product=x.page.locator('#products [data-product-id="'+x.productId+'"]');await product.waitFor();assert.match(await product.innerText(),/已回读|目录.*更新/);safe(x);await evidence(x,'verified-no-new-loss-1440',api);
 }finally{await x.close();}
});
for(const mode of ['off-shelf','excluded'])test('waiting recovery excludes '+mode+' even when an old two-scheme price requirement exists',{timeout:60000},async()=>{
 const x=await fixture({mode,width:960});try{
  const api=await x.get('products');assert.equal(api.attention.waitingCount,0);assert.equal(api.attention.waitingProductIds.includes(x.productId),false);assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);
  await waitingTab(x);await x.page.waitForFunction(()=>document.querySelector('#missing-count').textContent==='0');assert.equal(await x.page.locator('#products [data-product-id="'+x.productId+'"]').count(),0);safe(x);await evidence(x,mode+'-hidden-960',api);
 }finally{await x.close();}
});
