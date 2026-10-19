import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

const target='3000000000000000099';
const searchLabel='请输入商品名称/商品ID/商家编码，多条可用逗号隔开';
function recycleHtml({rows=[target],shopId='900001',changedQuery=false,badHeader=false}={}){
 return `<meta charset="utf-8"><div class="index_shopTitle__x"><span class="index_userName__x" title="独立测试店铺">独立测试店铺</span></div><div label="店铺ID" value="${shopId}"><span class="index_descValueText__x">${shopId}</span></div>
 <h1>商品管理回收站</h1><input placeholder="${searchLabel}"><button id="query">查询</button><p id="total">共36条</p>
 <table><thead><tr>${['','商品信息','价格','总库存','总销量','质量分','创建时间',badHeader?'更新时间':'进入回收站时间','操作'].map(h=>'<th>'+h+'</th>').join('')}</tr></thead><tbody><tr data-row-key="3000000000000000001"><td></td><td>尚未筛选 ID：3000000000000000001</td></tr></tbody></table>
 <script>window.writes=0;document.querySelector('#query').onclick=()=>setTimeout(()=>{
 document.querySelector('#total').textContent='共${rows.length}条';
 document.querySelector('tbody').innerHTML=${JSON.stringify(rows.map(id=>`<tr data-row-key="${id}"><td></td><td>回收站商品 ID：${id}</td><td>100.00</td><td>5</td><td>0</td><td>未诊断</td><td>2026/01/01\n10:00:00</td><td>2026/10/18\n14:01:36</td><td><button onclick="window.writes++">恢复</button><button onclick="window.writes++">彻底删除</button></td></tr>`).join('')||'<tr><td colspan="9">暂无数据</td></tr>')};
 if(${changedQuery})document.querySelector('input').value='3000000000000000000';
 },60);</script>`;
}
async function harness(run,options={}){
 const dir=await mkdtemp(join(tmpdir(),'guardian-recycled-')),fixture=await fixtureServer();
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:options.width||960,height:700}});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});let visits=0,writes=0;
 try{
  await platform.ensure();await browser.context.route('**/ffa/g/recycle',async route=>{visits++;await route.fulfill({contentType:'text/html; charset=utf-8',body:recycleHtml(options)});});
  const initialPages=browser.context.pages().length;
  const open=platform.open.bind(platform);platform.open=async path=>{const page=await open(path),close=page.close.bind(page);page.close=async()=>{if(path==='/ffa/g/recycle')writes+=await page.evaluate(()=>window.writes||0).catch(()=>0);return close();};return page;};
  await run({platform,fixture,browser,stats:()=>({visits,writes})});
  assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.submits,0);assert.equal(writes,0);assert.equal(browser.context.pages().length,initialPages);
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
}

for(const width of [960,1440])test(`missing picker product is independently identified in recycle bin at ${width}`,async()=>harness(async({platform,stats})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='PRODUCT_RECYCLED');
 assert.equal(stats().visits,1);
},{width}));

test('no recycle match keeps the original NOT_FOUND uncertainty',async()=>harness(async({platform})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='NOT_FOUND');
},{rows:[]}));

for(const code of ['PRODUCT_RECYCLED','NOT_FOUND'])test(`a prior ${code} result is rechecked live before skipping the picker`,async()=>harness(async({platform,fixture,stats})=>{
 platform.journal={productChecks:()=>[{shopId:'900001',productId:target,code}]};
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='PRODUCT_RECYCLED');
 assert.equal(fixture.state.prechecks,0);assert.equal(stats().visits,1);
}));

test('a product moved out of recycle can proceed to current SKU precheck',async()=>harness(async({platform,fixture})=>{
 platform.journal={productChecks:()=>[{shopId:'900001',productId:fixtureProducts[0].productId,code:'PRODUCT_RECYCLED'}]};
 const result=await platform.precheck(fixtureProducts[0]);assert.equal(result.complete,true);assert.equal(result.skus.length,10);assert.equal(fixture.state.prechecks,1);
},{rows:[]}));

for(const [name,options,code] of [
 ['another shop',{shopId:'900002'},'SHOP_MISMATCH'],
 ['duplicate rows',{rows:[target,target]},'RECYCLE_AMBIGUOUS'],
 ['query changed',{changedQuery:true},'RECYCLE_QUERY_CHANGED'],
 ['wrong table',{badHeader:true},'RECYCLE_LAYOUT']
])test(`${name} cannot classify a product as recycled`,async()=>harness(async({platform})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code===code);
},options));
