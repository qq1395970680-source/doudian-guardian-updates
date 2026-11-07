import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {formSlice} from '../../src/platform-snapshot.mjs';
import {fixtureServer} from './platform-fixture.mjs';
const products=[{productId:'3000000000000000901',name:'一口价合成商品',skus:[{id:'5000000000000000901',name:'固定金额甲',baseFen:10000,discount:null,saleFen:4784},{id:'5000000000000000902',name:'固定金额乙',baseFen:100000,discount:null,saleFen:56460}]}];
async function setup(options={}){
 const limited=options.limited===true,fixture=await fixtureServer({catalogProducts:structuredClone(products),fixedPrice:true,detailObservedPrices:false,...options});
 if(limited){const c=fixture.state.campaigns[0];Object.assign(c,{type:'限量抢购',autoRenew:true,status:'进行中',risk:true,startAt:Math.floor(Date.now()/1000)*1000-86400000});c.endAt=c.startAt+7*86400000;for(const p of c.products)Object.assign(p,{activityLimit:777,removalConfirmed:true,removalRiskConfirmed:true,soldOut:false});}
 const dir=await mkdtemp(join(tmpdir(),'guardian-fixed-native-')),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'guardian.sqlite')),policy={shopId:'900001',excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({journal,platform,policy});return{dir,browser,journal,policy,platform,service,fixture,async close(){service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}
test('one-price header reads exact spinbutton amount and refuses conflicting mode controls',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-fixed-snapshot-')),browser=new DedicatedBrowser(dir,{test:true});try{await browser.open('900001');const page=await browser.page();
  const html=extra=>'<table><thead><tr><th><span class="ecom-mcenter-select-selection-item">一口价<div class="ecom-mcenter-sp-tag">上次选择</div></span></th>'+extra+'</tr></thead><tbody><tr class="index-skuRow--x"><td></td><td>固定甲 原价：¥100.00</td><td><input role="spinbutton" value="47.84"></td></tr></tbody></table>';
  await page.setContent(html(''));const s=await page.evaluate(formSlice),row=s.cells[0].rows[0];assert.equal(s.priceMode,'fixed');assert.equal(row.discount,null);assert.equal(row.saleFen,4784);assert.equal(s.byDiscount,false);
  await page.locator('input[role="spinbutton"]').fill('');await page.locator('tr.index-skuRow--x td').last().evaluate(e=>{const warning=document.createElement('span');warning.className='ecom-mcenter-zform-error';warning.textContent='单品活动价￥47.84，需≤￥47.00';e.append(warning);});assert.equal((await page.evaluate(formSlice)).cells[0].rows[0].saleFen,null,'a warning cannot replace a blank fixed-price input');
  await page.setContent(html(''));await page.locator('tr.index-skuRow--x td').last().evaluate(e=>{const other=document.createElement('input');other.setAttribute('role','spinbutton');other.value='47.84';e.append(other);});assert.equal((await page.evaluate(formSlice)).cells[0].rows[0].saleFen,null,'duplicate fixed-price controls are not uniquely proved');
  await page.setContent(html('<th><span class="ecom-mcenter-select-selection-item">打折</span></th>'));const ambiguous=await page.evaluate(formSlice);assert.equal(ambiguous.priceMode,undefined);assert.equal(ambiguous.byDiscount,false);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
test('existing listing one-price reader can adapt the two real legacy expressions without weakening exact inputs',{timeout:30000},async()=>{
 // Same self-contained adapter algorithm already used by the independent
 // listing app; no production listing module or browser is imported/launched.
 const before=String.raw`const displayedSale=money(text(row.cells[2]).match(/折后价[：:]\s*[¥￥]([\d,.]+)/)?.[1]);`;
 const after=String.raw`const onePriceMode=[...document.querySelectorAll('th .ecom-mcenter-select-selection-item')].some(e=>e.checkVisibility()&&e.innerText.replace('上次选择','').trim()==='一口价');const displayedSale=onePriceMode?money(input?.value):money(text(row.cells[2]).match(/折后价[：:]\s*[¥￥]([\d,.]+)/)?.[1]);`;
 let source=formSlice.toString();assert.ok(source.includes(before));assert.ok(source.includes('discount:input?.value?Math.round(Number(input.value)*10):null,'));source=source.replace(before,()=>after).replace('discount:input?.value?Math.round(Number(input.value)*10):null,',()=> 'discount:onePriceMode?null:input?.value?Math.round(Number(input.value)*10):null,');const adapted=Function('return ('+source+')')();
 const dir=await mkdtemp(join(tmpdir(),'guardian-fixed-adapter-')),browser=new DedicatedBrowser(dir,{test:true});try{await browser.open('900001');const page=await browser.page();
  const html=(mode,value,label='')=>'<table><thead><tr><th><span class="ecom-mcenter-select-selection-item">'+mode+'<div class="ecom-mcenter-sp-tag">上次选择</div></span></th></tr></thead><tbody><tr class="index-skuRow--x"><td></td><td>同规格 原价：¥100.00</td><td><input role="spinbutton" value="'+value+'">'+label+'</td></tr></tbody></table>';
  for(const [mode,value,label]of [['一口价','47.84',''],['打折','4.8','折后价：¥48.00']]){await page.setContent(html(mode,value,label));const original=await page.evaluate(formSlice),legacy=await page.evaluate(adapted);assert.deepEqual(legacy,original);}
  await page.setContent(html('一口价','','<span class="ecom-mcenter-zform-error">单品活动价￥47.84，需≤￥47.00</span>'));assert.equal((await page.evaluate(adapted)).cells[0].rows[0].saleFen,null);
  await page.setContent(html('一口价','47.84','<input role="spinbutton" value="47.84">'));assert.equal((await page.evaluate(adapted)).cells[0].rows[0].saleFen,null);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
for(const limited of [false,true])test(`native fixed ${limited?'limited':'timed'} preserves arbitrary cents through history, official template, submit and independent readback`,{timeout:300000},async()=>{
 const s=await setup({limited,rememberedPriceMode:true,detailExpandable:true});try{
  await s.service.tick();const task=s.journal.list(s.policy.shopId)[0];assert.equal(task?.phase,'verified',JSON.stringify({task,status:s.service.status(),checks:s.journal.productChecks(s.policy.shopId)}));
  assert.equal(task.plans[0].priceMode,'fixed');assert.deepEqual(task.plans[0].skus.map(x=>[x.discount,x.saleFen]),[[null,4784],[null,56460]]);assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);assert.equal(task.receipt.skuCount,2);assert.equal(task.receipt.salePriceEvidence,'observed');
  assert.equal(s.fixture.state.templateDownloads,1);assert.equal(s.fixture.state.uploads,1);assert.equal(s.fixture.state.creates,1);assert.equal(s.fixture.state.submits,1);assert.equal(s.fixture.state.risks,1);
  const created=s.fixture.state.campaigns.find(c=>c.id===task.receipt.campaignId),independent=await s.platform.detail(created);assert.equal(independent.priceMode,'fixed');assert.deepEqual(independent.products[0].skus.map(x=>[x.discount,x.saleFen,x.saleSource]),[[null,4784,'observed'],[null,56460,'observed']]);if(limited)assert.equal(task.receipt.productLimits[0].activityLimit,777);
  await s.service.tick();assert.equal(s.fixture.state.submits,1);assert.equal(s.fixture.state.creates,1);assert.equal(s.fixture.state.editWrites||0,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',limited?'fixed-native-limited.json':'fixed-native-timed.json'),JSON.stringify({at:Date.now(),localFixtureOnly:true,livePlatformObserved:false,priceMode:'fixed',arbitraryCentsPreserved:[4784,56460],receipt:task.receipt,officialTemplateDownloads:s.fixture.state.templateDownloads,submits:1,risks:1,noRepeatAfterNextPatrol:true},null,2),'utf8');
 }finally{await s.close();}
});
test('limited fixed activity without its own native fixed template remains unsubmitted',{timeout:180000},async()=>{const s=await setup({limited:true,fixedTemplateAvailable:false});try{await s.service.tick();const task=s.journal.list(s.policy.shopId)[0];assert.equal(task?.phase,'blocked',JSON.stringify(s.service.status()));assert.match(task.reason,/FIXED_ACTIVITY_UNAVAILABLE/);assert.equal(task.submitAttempts,0);assert.equal(s.fixture.state.creates,0);assert.equal(s.fixture.state.submits,0);assert.equal(s.fixture.state.uploads,0);}finally{await s.close();}});
test('import that silently selects discount mode cannot submit fixed amounts',{timeout:180000},async()=>{const s=await setup({corruptFixedMode:true});try{await s.service.tick();const task=s.journal.list(s.policy.shopId)[0];assert.equal(task?.phase,'blocked',JSON.stringify(s.service.status()));assert.match(task.reason,/DRAFT_RULES/);assert.equal(task.submitAttempts,0);assert.equal(s.fixture.state.creates,0);assert.equal(s.fixture.state.submits,0);}finally{await s.close();}});
test('changed one-price amount is blocked before any create click',{timeout:180000},async()=>{const s=await setup({corruptPrice:true});try{await s.service.tick();const task=s.journal.list(s.policy.shopId)[0];assert.equal(task?.phase,'blocked',JSON.stringify(s.service.status()));assert.match(task.reason,/DRAFT_PRICE|DETAIL_CHANGED/);assert.equal(task.submitAttempts,0);assert.equal(s.fixture.state.creates,0);assert.equal(s.fixture.state.submits,0);}finally{await s.close();}});
test('native fixed-price cap produces exact amount review and never auto-submits a reduction',{timeout:180000},async()=>{const s=await setup({skuPriceCaps:{'5000000000000000901':4700}});try{
 await s.service.tick();const task=s.journal.list(s.policy.shopId)[0],reviews=s.journal.priceReviews(s.policy.shopId),review=reviews.find(r=>r.status==='pending');
 assert.equal(task?.phase,'blocked',JSON.stringify(s.service.status()));assert.ok(review,JSON.stringify({checks:s.journal.productChecks(s.policy.shopId),task}));assert.equal(review.priceMode,'fixed');assert.deepEqual(review.rows.map(r=>[r.id,r.previousFen,r.saleFen,r.discount]),[['5000000000000000901',4784,4700,null],['5000000000000000902',56460,56460,null]]);assert.equal(s.fixture.state.creates,0);assert.equal(s.fixture.state.submits,0);assert.equal(task.submitAttempts,0);
}finally{await s.close();}});
