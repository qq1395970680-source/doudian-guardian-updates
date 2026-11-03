import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {workspaceRedesignFixture,workspaceViews} from '../helpers/workspace-redesign-fixture.mjs';
import {projectBuild} from '../../src/build.mjs';

const consentSelector=['#care-policy-consent','#legacy-care-policy-consent','#original-consent','#original-price-consent','#original-rebuild-consent','#price-increase-consent','#transfer-consent','.price-consent input'].join(',');
async function openDisclosures(locator){
 // Only open real <details> summaries that wrap a requested user control.
 // This follows the same UI path as a person, without changing app state.
 const summaries=locator.locator('xpath=ancestor::details/summary');
 for(let i=0;i<await summaries.count();i++){
  const summary=summaries.nth(i),opened=await summary.evaluate(el=>el.parentElement.open);
  if(!opened)await summary.click();
 }
}
async function assertSurface(page,label){
 assert.equal(await page.locator('main h1:visible').count(),1,label+': one visible page heading');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,label+': no document overflow');
 const text=await page.locator('body').innerText();
 assert.doesNotMatch(text,/\b(?:undefined|NaN)\b/,label+': no raw missing values');
 assert.doesNotMatch(text,/按各商品原折扣分组守护限量抢购|每件商品共用\s*1000\s*件/,label+': removed campaign banner');
 assert.equal(await page.locator(consentSelector).evaluateAll(inputs=>inputs.filter(input=>input.checked).length),0,label+': no pre-approved price or migration consent');
}
async function settleView(page,view){
 await page.locator(`[data-view="${view}"]`).click();await page.locator('#view-'+view).waitFor({state:'visible'});
 const ready={overview:'#products',recoveries:'#recovery-records',accounts:'#account-list',workspace:'#price-reviews',activity:'#tasks',updates:'#update-status'}[view];
 await page.waitForFunction(selector=>{const el=document.querySelector(selector);return el&&el.textContent.trim()&&!/正在读取|正在加载/.test(el.textContent);},ready,{timeout:12000});
}

for(const width of [1440,960])for(const empty of [false,true])test(`whole workspace redesign ${empty?'empty':'mixed'} ${width}`,{timeout:120000},async()=>{
 const x=await workspaceRedesignFixture({empty}),browser=new DedicatedBrowser(join(x.runtime,'ui'),{test:true,viewport:{width,height:1000}});
 const mode=empty?'empty':'mixed',artifacts=resolve('artifacts','workspace-redesign',mode+'-'+width);await mkdir(artifacts,{recursive:true});
 const report={localFixtureOnly:true,headless:true,productionTouched:false,mode,width,pages:[],extraScreens:[],unexpectedPosts:[],errors:[]};
 let page;
 try{
  await browser.open(x.shopId);page=await browser.page();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>report.errors.push(error.message));
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(x.app.url);
  await page.waitForFunction(()=>document.querySelector('#version')?.textContent.includes('2.0.0-'));
  const original=x.snapshot();
  for(const view of workspaceViews){
   await settleView(page,view);await assertSurface(page,mode+'/'+view);
   await page.screenshot({path:join(artifacts,view+'.png'),fullPage:false,animations:'disabled'});
   report.pages.push({view,visibleHeadings:1,noOverflow:true,noDangerousDefaultConsent:true,screenshot:join(artifacts,view+'.png')});
  }
  assert.deepEqual(posts,[],'read-only navigation does not issue a business POST');
  assert.deepEqual(x.snapshot(),original,'read-only navigation does not alter tasks, attempts or price targets');
  if(empty){
   for(const view of ['overview','recoveries','workspace','activity']){
    await settleView(page,view);assert.ok((await page.locator('#view-'+view).innerText()).trim().length>0,'clear empty state '+view);
   }
   assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#choose-transfer').isDisabled(),true);
  }else{
   await settleView(page,'overview');assert.equal(await page.locator('#unknown-count').innerText(),'2');
   await page.locator('[data-filter="active"]').click();await page.waitForFunction(()=>document.querySelector('#total-label').textContent==='37 件商品');
   const product=page.locator('#products [data-product-id="310000"]');await product.waitFor();assert.match(await product.locator('summary').innerText(),/50\.00/);
   await page.screenshot({path:join(artifacts,'overview-active.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('overview-active');
   await product.locator('summary').click();await product.locator('.sku-table').waitFor();assert.equal(await product.locator('.sku-table tbody tr').count(),32,'active product retains every SKU in its disclosure');
   await product.locator('.sku-detail h3').scrollIntoViewIfNeeded();await assertSurface(page,mode+'/active-skus');
   await page.screenshot({path:join(artifacts,'overview-skus.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('overview-skus');
   await product.locator('summary').click();await page.locator('[data-filter="all"]').click();
   await settleView(page,'recoveries');const recovered=page.locator('#recovery-records .recovery-card').first();await recovered.locator('summary').click();await recovered.locator('table').waitFor();
   assert.equal(await recovered.locator('tbody tr').count(),10);assert.match(await recovered.innerText(),/27 个规格 · 1 \/ 3/);
   await recovered.getByRole('button',{name:'下一页规格',exact:true}).click();assert.match(await recovered.innerText(),/27 个规格 · 2 \/ 3/);assert.equal(await recovered.locator('tbody tr').count(),10);
   await recovered.locator('.recovery-detail').scrollIntoViewIfNeeded();await assertSurface(page,mode+'/recovery-details');
   await page.screenshot({path:join(artifacts,'recovery-details.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('recovery-details');
   await settleView(page,'activity');await page.locator('#tasks .record-details > summary').first().click();await page.locator('#event-stream > summary').click();await page.locator('#events .record-details > summary').first().click();
   assert.equal(await page.locator('#tasks .record-details[open]').count(),1);assert.equal(await page.locator('#events .record-details[open]').count(),1);await assertSurface(page,mode+'/task-event-details');
   await page.screenshot({path:join(artifacts,'activity-details.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('activity-details');
   await settleView(page,'workspace');
   await page.locator('[data-workspace-scope="confirm"]').click();
   const openPrice=page.locator(`button[data-open-price-review="${x.priceProductId}"]`).first();await openPrice.waitFor();await openPrice.click();
   const drawer=page.locator('dialog[data-price-workspace]');await drawer.waitFor({state:'visible'});
   assert.equal(await drawer.locator('[data-activity-price-type]').count(),2,'both activities share one price workspace');
   await drawer.getByRole('combobox',{name:'选择价格调整方案',exact:true}).selectOption('original');
   await drawer.locator('table[data-role="price-target-table"]').waitFor();
   assert.equal(await drawer.locator('table[data-role="price-target-table"]').count(),1,'one complete target-price table');
   assert.equal(await drawer.locator('[data-activity-price-type] table').count(),0,'activity comparison does not repeat SKU tables');
   assert.equal(await drawer.getByRole('combobox',{name:'选择价格调整方案',exact:true}).count(),1,'strategies use one compact selector');
   assert.doesNotMatch(await drawer.innerText(),/原算法|历史算法|fingerprint|schema/,'price decisions use plain product language');
   assert.match(await drawer.locator('table[data-role="price-target-table"]').innerText(),/63\.94/);
   assert.equal(await drawer.locator('.price-consent input:checked').count(),0);assert.equal(await drawer.locator('.price-consent input').isChecked(),false);
   await page.screenshot({path:join(artifacts,'price-workspace.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('price-workspace');
   await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
   assert.deepEqual(posts,[],'opening and selecting a price preview does not approve or enqueue');assert.deepEqual(x.snapshot(),original);
   assert.equal(await page.locator('#price-count').innerText(),'1','original-price mode still exposes one actionable lower-price decision');
   const pendingIds=await page.locator('#price-reviews [data-open-price-review]').evaluateAll(elements=>[...new Set(elements.map(el=>el.dataset.openPriceReview))]);
   assert.ok(pendingIds.includes(x.priceProductId));assert.ok(!pendingIds.some(id=>['390002','390003','390004'].includes(id)),'history and expired suggestions stay out of pending queue');
   await page.locator('[data-price-scope="history"]').click();await page.getByText('历史已确认商品',{exact:true}).waitFor();
   assert.doesNotMatch(await page.locator('#price-reviews').innerText(),/过期建议商品/);
   assert.equal(await page.locator('#price-reviews table').count(),0,'history page is a compact list, not another full price editor');
   await page.screenshot({path:join(artifacts,'price-history.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('price-history');
   await page.locator('[data-workspace-scope="automatic"]').click();await page.locator('#price-reviews [data-workspace-product]').first().waitFor();await assertSurface(page,mode+'/automatic');await page.screenshot({path:join(artifacts,'automatic-verification.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('automatic-verification');
   await page.locator('[data-price-scope="pending"]').click();await openPrice.waitFor();
   await settleView(page,'accounts');
   assert.equal(x.app.snapshot().originalPriceRecoveryEnabled,true,'existing original-price authorization is preserved');
   assert.equal(await page.locator('#care-policy-status').isVisible(),true);assert.ok((await page.locator('#care-policy-status').innerText()).trim().length>0);
   const careCopy=await page.locator('.care-policy').innerText();assert.match(careCopy,/两种方案/);assert.match(careCopy,/不降价/);assert.match(careCopy,/两种都需降价/);
   assert.equal(await page.locator('#care-policy-consent').isChecked(),false);
   await page.locator('.advanced-settings > summary').click();await page.locator('.advanced-settings').scrollIntoViewIfNeeded();await assertSurface(page,mode+'/advanced');await page.screenshot({path:join(artifacts,'store-advanced.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('store-advanced');
   await page.locator('#app-tools-toggle').click();await page.locator('#app-tools').waitFor({state:'visible'});
   await page.screenshot({path:join(artifacts,'app-tools.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('app-tools');
   await page.keyboard.press('Escape');assert.equal(await page.locator('#app-tools').isVisible(),false);
   await page.locator('#app-tools-toggle').click();await page.locator('[data-tool="diagnostics"]').click();
   await page.locator('#view-activity').waitFor({state:'visible'});assert.equal(await page.locator('#export-diagnostics').isVisible(),true,'diagnostics tool reveals its collapsed controls');
   await page.screenshot({path:join(artifacts,'activity-diagnostics.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('activity-diagnostics');
   assert.deepEqual(posts,[],'opening diagnostics does not export data');await settleView(page,'accounts');
   // A migration preview is read-only even while two submission results are
   // unresolved. This fixture deliberately never imports or exports anything.
   await page.evaluate(file=>{window.__workspaceTransfer=file;window.guardianDesktop={chooseTransfer:async()=>({file:window.__workspaceTransfer}),saveTransfer:async()=>{throw Error('Visual test cannot export files');}};},x.transferFile);
   const choose=page.locator('#choose-transfer');await openDisclosures(choose);await choose.click();await page.locator('#transfer-preview').waitFor({state:'visible'});
   assert.equal(await page.locator('#transfer-consent').isChecked(),false);assert.equal(await page.locator('#import-transfer').isDisabled(),true);
   await page.locator('.transfer-product summary').first().click();await page.locator('#transfer-products td').filter({hasText:/69\.50/}).first().waitFor();assert.match(await page.locator('#transfer-products').innerText(),/69\.50/);
   await page.locator('#transfer-preview').scrollIntoViewIfNeeded();await page.screenshot({path:join(artifacts,'migration-preview.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('migration-preview');
   assert.deepEqual(x.snapshot(),original,'migration preview does not import or alter journal records');
   await page.evaluate(file=>{window.__workspaceTransfer=file;},x.emptyTransferFile);await choose.click();await page.getByText('备份中没有折扣历史',{exact:true}).waitFor();
   await page.screenshot({path:join(artifacts,'migration-empty.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('migration-empty');
   assert.equal(await page.locator('#transfer-consent').isChecked(),false);assert.equal(await page.locator('#import-transfer').isDisabled(),true);
   const allowedPreviewPosts=posts.filter(path=>path==='/api/migration/preview');assert.equal(allowedPreviewPosts.length,2);
   // Mock only this isolated app's update response. No GitHub, installer or
   // real desktop bridge is invoked by these UI-state checks.
   await page.evaluate(()=>{delete window.guardianDesktop;});let updateMode='available';
   await page.route('**/api/updates/check',route=>route.fulfill({json:updateMode==='available'?{state:'available',release:{version:'9.0.0-beta.1',notes:'隔离更新预览：改善待处理事项显示。'}}:updateMode==='current'?{state:'current'}:{state:'error',message:'隔离网络测试：暂时无法连接更新源'}}));
   await settleView(page,'updates');await page.locator('#check-updates').click();await page.getByText('发现新版本 9.0.0-beta.1',{exact:true}).waitFor();assert.equal(await page.locator('#install-update').isVisible(),true);
   await page.screenshot({path:join(artifacts,'update-available.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('update-available');
   updateMode='current';await page.locator('#check-updates').click();await page.getByText('当前已是最新发布版本',{exact:true}).waitFor();assert.equal(await page.locator('#install-update').isVisible(),false);
   updateMode='error';await page.locator('#check-updates').click();await page.getByText('隔离网络测试：暂时无法连接更新源',{exact:true}).waitFor();assert.equal(await page.locator('#install-update').isVisible(),false);
   await page.screenshot({path:join(artifacts,'update-error.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('update-error');
   await assertSurface(page,mode+'/after-panels');
   assert.deepEqual(x.snapshot(),original,'all view/preview/update checks preserve business state');
   report.unexpectedPosts=posts.filter(path=>!['/api/migration/preview','/api/updates/check'].includes(path));assert.deepEqual(report.unexpectedPosts,[]);
  }
  await settleView(page,'overview');await page.emulateMedia({reducedMotion:'reduce',contrast:'more'});await assertSurface(page,mode+'/increased-contrast');
  assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).backdropFilter),'none','increased contrast uses a solid navigation surface');
  await page.screenshot({path:join(artifacts,'increased-contrast.png'),fullPage:false,animations:'disabled'});report.extraScreens.push('increased-contrast');
  assert.deepEqual(report.errors,[]);report.sourceBuild=x.app.snapshot().sourceBuild;
  assert.equal(await projectBuild(resolve(import.meta.dirname,'../..')),report.sourceBuild,'app source stays unchanged throughout this verification');report.verifiedAt=new Date().toISOString();
  await writeFile(join(artifacts,'verification.json'),JSON.stringify(report,null,2)+'\n');
 }catch(error){
  report.failure={message:error.message,stack:error.stack};
  if(page){report.failure.view=await page.locator('#view-name').textContent().catch(()=>null);report.failure.visibleText=(await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:join(artifacts,'failure.png'),fullPage:false,animations:'disabled'}).catch(()=>{});}
  await writeFile(join(artifacts,'verification-failed.json'),JSON.stringify(report,null,2)+'\n');throw error;
 }finally{await browser.close();await x.close();}
});
