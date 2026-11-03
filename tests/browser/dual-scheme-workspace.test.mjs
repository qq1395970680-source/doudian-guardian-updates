import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {dualBlockerFixture as blockerFixture} from '../helpers/dual-price-ui-fixture.mjs';
import {closePriceWorkspace} from '../helpers/price-workspace-ui.mjs';

const timed='限时抢购',limited='限量抢购';
async function states(x){
 const live=await(await fetch(x.app.url+'/api/price-reviews/item?productId='+x.review.productId)).json();
 assert.equal(live.approvalAllowed,true,'the positive case must come from two real independently recorded draft proofs');
 assert.equal(live.comparison.filter(s=>s.classification==='reduction-required').length,2);
 const cases=[
  {id:'310001',name:'限量尚未核验',flags:[false,'reduction-required','pending']},
  {id:'310002',name:'缺少服务端批准标志',flags:[undefined,'reduction-required','reduction-required']},
  {id:'310003',name:'限量没有合法价格',flags:[false,'reduction-required','unavailable']},
  {id:'310004',name:'不一致标志也须关闭批准',flags:[true,'reduction-required','pending']},
  {id:'310005',name:'已有未知提交只回读',flags:[true,'reduction-required','reduction-required'],blocked:true},
  {id:x.review.productId,name:'两种活动均需降价',flags:[true,'reduction-required','reduction-required']}
 ];
 for(const c of cases){
  if(c.id===x.review.productId){c.item=structuredClone(live);continue;}
  // Only the negative cases mutate the advisory DTO. The valid confirmation
  // above uses the real API result and the backend's actual pair key/options.
  const comparison=live.comparison.map((scheme,index)=>({...structuredClone(scheme),classification:c.flags[index+1]}));
  c.item={...structuredClone(live),productId:c.id,blocked:!!c.blocked,blockedReason:c.blocked?'上次提交结果尚未明确，只独立回读':null,readOnly:false,canRecalculate:!c.blocked,comparison,
   review:{...structuredClone(live.review),id:c.id+'-review',key:c.id+'-key',productId:c.id,name:c.name,activityComparison:comparison,canRecalculate:!c.blocked}};
  if(c.flags[0]===undefined)delete c.item.approvalAllowed;else c.item.approvalAllowed=c.flags[0];
 }
 return cases;
}
async function scope(page,value){await page.locator('[data-view="workspace"]').click();await page.locator('[data-workspace-scope="'+value+'"]').click();}
async function open(page,value,product){await scope(page,value);const row=page.locator('#price-reviews [data-workspace-product="'+product.id+'"]');await row.waitFor();await row.locator('[data-open-price-review]').click();const dialog=page.locator('dialog[data-price-workspace]');await dialog.locator('[data-review-id="'+product.item.review.id+'"]').waitFor();return dialog;}
async function safeSurface(page){assert.equal(await page.locator('main h1:visible').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.doesNotMatch(await page.locator('body').innerText(),/\b(?:undefined|NaN)\b/);}

for(const width of [1440,960])test('one recovery workspace fails closed until both reductions are proved, and history stays read-only '+width,{timeout:60000},async()=>{
 const x=await blockerFixture(),dir=await mkdtemp(join(tmpdir(),'guardian-dual-workspace-')),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:1000}}),artifacts=resolve('artifacts','dual-scheme-workspace',String(width));
 let release;
 try{
  const cases=await states(x);await mkdir(artifacts,{recursive:true});
  await browser.open(x.review.shopId);const page=await browser.page(),posts=[],errors=[],itemReads=[];page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);if(request.url().includes('/api/price-reviews/item?'))itemReads.push(new URL(request.url()));});
  let empty=false,holdHistory=false,historyEntered,historyGate;const counts={confirm:1,automatic:5,history:1};
  const record=(c,history=false)=>({productId:c.id,name:c.name,category:c.blocked?'verification':'needs-evidence',summary:c.name+'；两种方案的状态分别保留',updatedAt:Date.now(),verificationState:c.blocked?'verification':'pending',canRecheck:!c.blocked,...(history?{reviewId:c.item.review.id}:{})});
  await page.route('**/api/status',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({json:{...data,recoveryWorkspaceCounts:empty?{confirm:0,automatic:0,history:0}:counts}});});
  await page.route(/\/api\/recovery-workspace\?/,async route=>{
   const q=new URL(route.request().url()).searchParams,s=q.get('scope');if(s==='history'&&holdHistory){historyEntered();await historyGate;}
   const records=empty?[]:s==='confirm'?[record(cases[5])]:s==='history'?[record(cases[5],true)]:cases.slice(0,5).map(c=>record(c));
   await route.fulfill({json:{shopId:x.review.shopId,scope:s,counts:empty?{confirm:0,automatic:0,history:0}:counts,records,total:s==='automatic'&&!empty?5:records.length,page:0,pages:1}});
  });
  await page.route(/\/api\/price-reviews\/item\?/,route=>{const id=new URL(route.request().url()).searchParams.get('productId'),c=cases.find(c=>c.id===id);return route.fulfill({json:c.item});});
  await page.goto(x.app.url);await scope(page,'automatic');await page.locator('#price-reviews [data-workspace-product="310001"]').waitFor();
  assert.equal(await page.locator('[data-view="workspace"]').count(),1);assert.equal(await page.locator('[data-view="prices"]:visible,[data-view="blockers"]:visible').count(),0);
  const ids=await page.locator('#price-reviews [data-workspace-product]').evaluateAll(rows=>rows.map(row=>row.dataset.workspaceProduct));assert.equal(ids.length,5);assert.equal(new Set(ids).size,5,'the same product is never rendered twice');await safeSurface(page);
  await page.screenshot({path:join(artifacts,'automatic.png'),fullPage:false});
  for(const c of cases.slice(0,5)){
   const dialog=await open(page,'automatic',c);assert.equal(await dialog.locator('.price-consent input:checked').count(),0);
   assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).filter({visible:true}).count()?await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).isEnabled():false,false,c.name+' cannot approve');
   const edit=dialog.getByRole('button',{name:'手动调整折扣',exact:true}).filter({visible:true});if(await edit.count())assert.equal(await edit.isDisabled(),true,c.name+' cannot bypass proof through manual editing');
   assert.equal(await dialog.locator('[data-activity-price-type]').count(),2);assert.equal(await dialog.locator('[data-activity-price-type] table').count(),0);
   for(const [index,type]of [timed,limited].entries())assert.equal(await dialog.locator('[data-activity-price-type="'+type+'"]').getAttribute('data-scheme-state'),c.flags[index+1]);
   if(c.blocked)await page.screenshot({path:join(artifacts,'unknown-read-only.png'),fullPage:false});await closePriceWorkspace(page);
  }
  const dialog=await open(page,'confirm',cases[5]);assert.equal(await dialog.locator('table[data-role="price-target-table"]').count(),1);assert.equal(await dialog.locator('tbody tr').count(),2);assert.match(await dialog.locator('table').innerText(),/66\.72/);
  assert.equal(await dialog.locator('.price-consent input').isChecked(),false);assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).isDisabled(),true);
  await dialog.locator('.price-consent input').check();await dialog.locator('[data-activity-price-type="'+limited+'"] [data-activity-price-choice]').click();assert.equal(await dialog.locator('.price-consent input').isChecked(),false,'choosing the other independent cap clears consent');assert.match(await dialog.locator('table').innerText(),/63\.94/);
  await safeSurface(page);await page.screenshot({path:join(artifacts,'both-reductions.png'),fullPage:false});await closePriceWorkspace(page);
  // Hold a history read while changing back. Its late response must not leak
  // old record semantics into an automatic row or leave stale actions visible.
  holdHistory=true;const started=new Promise(resolve=>{historyEntered=resolve;});historyGate=new Promise(resolve=>{release=resolve;});await scope(page,'history');await started;
  assert.equal(await page.locator('#price-reviews [data-open-price-review]').count(),0);await page.locator('[data-workspace-scope="automatic"]').click();holdHistory=false;release();await page.locator('#price-reviews [data-workspace-product="310001"]').waitFor();assert.equal(await page.locator('#price-reviews [data-workspace-product="'+cases[5].id+'"]').count(),0);
  const history=await open(page,'history',cases[5]);assert.equal(itemReads.at(-1).searchParams.get('reviewId'),cases[5].item.review.id);
  assert.equal(await history.locator('.price-consent input').count(),0);assert.equal(await history.locator('[data-manual-sku]').count(),0);assert.equal(await history.getByRole('button',{name:'重新核对',exact:true}).count(),0);assert.equal(await history.locator('[data-current-recheck]').count(),0,'an explicit historical view cannot recheck a newer proposal');
  await page.screenshot({path:join(artifacts,'history-read-only.png'),fullPage:false});await closePriceWorkspace(page);
  empty=true;await scope(page,'confirm');await page.getByText('当前没有需要你确认的降价',{exact:true}).waitFor();await safeSurface(page);await page.screenshot({path:join(artifacts,'empty.png'),fullPage:false});
  assert.deepEqual(posts,[],'navigation, references and checking consent never approve, submit or request recovery');assert.deepEqual(errors,[]);assert.equal(x.journal.priceTarget(x.review.shopId,x.review.productId),null);assert.equal(x.journal.get(x.f.task.id).submitAttempts,0);
 }finally{release?.();await browser.close();await x.close();await rm(dir,{recursive:true,force:true});}
});
