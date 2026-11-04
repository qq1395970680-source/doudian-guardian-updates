import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {officialQuerySurfaceSnapshot,officialQueryCoverage} from '../../src/official-query-coverage.mjs';
import {submissionListFilterSnapshot,submissionQueryScope} from '../../src/submission-investigation.mjs';

const select=(label,selected='')=>`<div class="ecom-mcenter-form-item"><div class="ecom-mcenter-form-item-label"><label>${label}</label></div><div class="ecom-mcenter-select"><div class="ecom-mcenter-select-selector">${selected?`<span class="ecom-mcenter-select-selection-item">${selected}</span>`:'<span class="ecom-mcenter-select-selection-placeholder">请选择</span>'}<input role="combobox" type="search" value=""></div></div></div>`;
const html=`<!doctype html><meta charset="utf-8"><aside id="statistics"><h2>数据概览</h2><p>以下数据仅统计生效单品直降的商品订单数据</p><div class="ecom-mcenter-picker"><span>2026/10/28-2026/11/03</span><label><input type="radio" name="statisticsRange" checked>近7天</label><input placeholder="开始日期" value=""><input placeholder="结束日期" value=""></div></aside><form id="query"><div class="ecom-mcenter-form-item"><label>活动名称</label><input placeholder="请输入活动名称"></div><div class="ecom-mcenter-form-item"><label>商品ID</label><input placeholder="请输入商品ID"></div>${select('活动状态','全部')}${select('优惠类型')}${select('活动类型')}<button type="button">查询</button><button type="button">重置</button></form><input type="hidden" value="hidden-secret"><input type="password" value="password-secret"><input placeholder="手机号" value="phone-secret"><script>window.changed=0;document.addEventListener('click',()=>window.changed++);document.addEventListener('input',()=>window.changed++);</script>`;
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'guardian-official-coverage-')),browser=new DedicatedBrowser(root,{test:true});let posts=0;
 const server=createServer((req,res)=>{if(req.method!=='GET')posts++;res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await browser.open('900001');const page=await browser.page();await page.goto(`http://127.0.0.1:${server.address().port}/ffa/marketing/tools/limitsales`);await work(page);assert.equal(posts,0);}
 finally{await browser.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
}
async function snapshot(page){const querySurface=await page.evaluate(officialQuerySurfaceSnapshot);return page.evaluate(submissionListFilterSnapshot,{querySurface});}
function listing(before,after){const now=Date.now(),query={productId:null,title:null,status:null};return{complete:true,shopId:'900001',observedAt:now,query,
 campaigns:[{id:'400001',type:'限时抢购',status:'已结束',startAt:Date.parse('2026-10-03T00:00:00+08:00'),endAt:Date.parse('2026-10-07T00:00:00+08:00')}],
 queryScope:submissionQueryScope({shopId:'900001',query,before,after,pages:1})};}

test('native query boundary separates statistics dates/radio and captures both actual empty type placeholders',{timeout:60000},()=>fixture(async page=>{
 const before=await snapshot(page),after=await snapshot(page),s=after.querySurface;
 assert.equal(s.complete,true);assert.equal(s.queryRegion.tag,'form');assert.equal(s.queryRegion.selects.length,3);assert.equal(s.queryRegion.visibleInputCount,5);assert.equal(s.queryRegion.fields.length,2);
 assert.deepEqual(s.queryRegion.selects.filter(f=>f.label!=='活动状态').map(f=>[f.label,f.selected,f.placeholder]),[['优惠类型','','请选择'],['活动类型','','请选择']]);
 assert.equal(s.statisticsDates.length,1);assert.match(s.statisticsDates[0].context,/数据概览.*商品订单数据/);assert.deepEqual(s.statisticsDates[0].range,['2026/10/28','2026/11/03']);
 assert.deepEqual(after.dateControls,[]);assert.deepEqual(after.selectedFilters,[]);assert.deepEqual(after.selectedTabs,[]);
 const r=officialQueryCoverage(listing(before,after));assert.equal(r.complete,true,JSON.stringify(r));assert.equal(r.allDates,true);assert.deepEqual(r.activityTypes,['限时抢购','限量抢购']);
 assert.doesNotMatch(JSON.stringify(after),/hidden-secret|password-secret|phone-secret/);assert.equal(await page.evaluate(()=>window.changed),0);
}));
test('native query extras remain explicit and restricted type selections cannot claim all coverage',{timeout:60000},()=>fixture(async page=>{
 await page.evaluate(()=>document.querySelector('#query').insertAdjacentHTML('beforeend','<label><input type="checkbox" checked>只看我创建</label><div role="tab" aria-selected="true">限量抢购</div>'));
 const before=await snapshot(page),after=await snapshot(page);assert.deepEqual(after.selectedFilters,[{kind:'checkbox',label:'只看我创建'}]);assert.deepEqual(after.selectedTabs,['限量抢购']);
 assert.equal(officialQueryCoverage(listing(before,after)).complete,false);assert.equal(listing(before,after).queryScope.verified,false);
 await page.evaluate(()=>{document.querySelector('#query input[type="checkbox"]').closest('label').remove();document.querySelector('#query [role="tab"]').remove();const root=[...document.querySelectorAll('#query .ecom-mcenter-form-item')].find(e=>e.textContent.includes('优惠类型'));root.querySelector('.ecom-mcenter-select-selector').innerHTML='<span class="ecom-mcenter-select-selection-item">限时抢购</span>';});
 const narrowed=await snapshot(page),restricted=listing(narrowed,structuredClone(narrowed));assert.equal(restricted.queryScope.verified,false);assert.ok(restricted.queryScope.unrecognizedSelections.includes('限时抢购'));assert.equal(officialQueryCoverage(restricted).code,'LISTING_UNPROVEN');
 assert.equal(await page.evaluate(()=>window.changed),0);
}));
test('native visible statistics range remains positive evidence when its date popup has no visible inputs',{timeout:60000},()=>fixture(async page=>{
 await page.evaluate(()=>{for(const input of document.querySelectorAll('#statistics input'))input.style.display='none';});
 const before=await snapshot(page),after=await snapshot(page);assert.equal(after.querySurface.complete,true);assert.equal(after.querySurface.statisticsDates.length,1);
 assert.deepEqual(after.querySurface.statisticsDates[0].range,['2026/10/28','2026/11/03']);assert.match(after.querySurface.statisticsDates[0].context,/数据概览.*商品订单数据/);
 assert.deepEqual(after.dateControls,[]);assert.deepEqual(after.selectedFilters,[]);assert.equal(officialQueryCoverage(listing(before,after)).complete,true);
 assert.doesNotMatch(JSON.stringify(after),/hidden-secret|password-secret|phone-secret/);assert.equal(await page.evaluate(()=>window.changed),0);
}));
test('native capture refuses a whole-page common ancestor and never infers all dates from missing controls',{timeout:60000},()=>fixture(async page=>{
 await page.evaluate(()=>document.querySelector('#query').prepend(document.querySelector('#statistics')));
 const s=await page.evaluate(officialQuerySurfaceSnapshot);assert.equal(s.complete,false);assert.equal(s.reason,'unique-bounded-query-region-not-found');
 const after=await page.evaluate(submissionListFilterSnapshot,{querySurface:s});assert.deepEqual(after.dateControls,[]);assert.equal(officialQueryCoverage(listing(after,structuredClone(after))).complete,false);
 assert.equal(await page.evaluate(()=>window.changed),0);
}));
