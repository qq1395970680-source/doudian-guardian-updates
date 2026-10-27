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
function recycleHtml({rows=[target],shopId='900001',changedQuery=false,badHeader=false,emptyText='暂无数据'}={}){
 return `<meta charset="utf-8"><div class="index_shopTitle__x"><span class="index_userName__x" title="独立测试店铺">独立测试店铺</span></div><div label="店铺ID" value="${shopId}"><span class="index_descValueText__x">${shopId}</span></div>
 <h1>商品管理回收站</h1><input placeholder="${searchLabel}"><button id="query">查询</button><p id="total">共36条</p>
 <table><thead><tr>${['','商品信息','价格','总库存','总销量','质量分','创建时间',badHeader?'更新时间':'进入回收站时间','操作'].map(h=>'<th>'+h+'</th>').join('')}</tr></thead><tbody><tr data-row-key="3000000000000000001"><td></td><td>尚未筛选 ID：3000000000000000001</td></tr></tbody></table>
 <script>window.writes=0;document.querySelector('#query').onclick=()=>setTimeout(()=>{
 document.querySelector('#total').textContent='共${rows.length}条';
 document.querySelector('tbody').innerHTML=${JSON.stringify(rows.map(id=>`<tr data-row-key="${id}"><td></td><td>回收站商品 ID：${id}</td><td>100.00</td><td>5</td><td>0</td><td>未诊断</td><td>2026/01/01\n10:00:00</td><td>2026/10/18\n14:01:36</td><td><button onclick="window.writes++">恢复</button><button onclick="window.writes++">彻底删除</button></td></tr>`).join('')||'<tr><td colspan="9">'+emptyText+'</td></tr>')};
 if(${changedQuery})document.querySelector('input').value='3000000000000000000';
 },60);</script>`;
}
function managedHtml({managedRows=[],managedBadHeader=false}={}){
 const headers=['','商品信息','价格','总库存','总销量','质量分',managedBadHeader?'未知时间':'创建时间','操作'];
 return `<meta charset="utf-8"><div class="index_shopTitle__x"><span class="index_userName__x" title="独立测试店铺">独立测试店铺</span></div><div label="店铺ID" value="900001"><span class="index_descValueText__x">900001</span></div>
 <h1>商品管理</h1><button role="tab" aria-selected="false" id="all">全部</button><button role="tab" aria-selected="true" id="selling">售卖中</button><span>已下架</span>
 <input placeholder="${searchLabel}"><button id="query">查询</button><p id="total">共94条</p><table><thead><tr>${headers.map(h=>'<th>'+h+'</th>').join('')}</tr></thead><tbody></tbody></table>
 <script>window.writes=0;document.querySelector('#all').onclick=()=>{document.querySelector('#all').setAttribute('aria-selected','true');document.querySelector('#selling').setAttribute('aria-selected','false');document.querySelector('input').value='';};
 document.querySelector('#query').onclick=()=>setTimeout(()=>{document.querySelector('#total').textContent='共${managedRows.length}条';document.querySelector('tbody').innerHTML=${JSON.stringify(managedRows.map(p=>`<tr data-row-key="${p.id}"><td></td><td>测试商品 ID：${p.id}</td><td>100.00</td><td>9</td><td>0</td><td>未诊断</td><td>2026/05/02\n14:42:11\n${p.status}\n查看原因</td><td><button onclick="window.writes++">上架</button><button onclick="window.writes++">下架</button></td></tr>`).join('')||'<tr><td colspan="8">当前分类下未找到符合条件的商品，可点击 全部商品 分类下查询</td></tr>')};},60);</script>`;
}
async function harness(run,options={}){
 const dir=await mkdtemp(join(tmpdir(),'guardian-recycled-')),fixture=await fixtureServer();
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:options.width||960,height:700}});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});let visits=0,writes=0,managedVisits=0;const managedQueries=[];
 try{
  await platform.ensure();await browser.context.route('**/ffa/g/recycle',async route=>{visits++;await route.fulfill({contentType:'text/html; charset=utf-8',body:recycleHtml(options)});});
  await browser.context.route('**/ffa/g/list*',async route=>{managedVisits++;await route.fulfill({contentType:'text/html; charset=utf-8',body:managedHtml(options)});});
  const initialPages=browser.context.pages().length;
  const open=platform.open.bind(platform);platform.open=async path=>{const page=await open(path),close=page.close.bind(page);page.close=async()=>{if(['/ffa/g/recycle','/ffa/g/list'].includes(path))writes+=await page.evaluate(()=>window.writes||0).catch(()=>0);if(path==='/ffa/g/list')managedQueries.push(await page.getByPlaceholder(searchLabel,{exact:true}).inputValue());return close();};return page;};
  await run({platform,fixture,browser,stats:()=>({visits,writes,managedVisits,managedQueries})});
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

test('current live recycle empty wording preserves the picker NOT_FOUND result',async()=>harness(async({platform})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='NOT_FOUND');
},{rows:[],emptyText:'当前分类下未找到符合条件的商品，可点击 全部商品 分类下查询'}));

test('unrecognized recycle empty results retain live query evidence before closing the page',async()=>harness(async({platform})=>{
 const captures=[];
 platform.fault=async(page,productId,stage,error)=>captures.push({pageOpen:!page.isClosed(),productId,stage,code:error.code,detail:error.detail});
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='RECYCLE_INCOMPLETE');
 assert.equal(captures.length,1,'recycle errors must be captured on the recycle page before cleanup');
 const capture=captures[0];assert.equal(capture.pageOpen,true);assert.equal(capture.productId,target);assert.equal(capture.stage,'product-state');
 assert.equal(capture.detail.productStateQuery.productId,target);assert.equal(capture.detail.productStateQuery.queryValue,target);
 assert.equal(capture.detail.productStateQuery.snapshot.path,'/ffa/g/recycle');
 assert.ok(capture.detail.productStateQuery.snapshot.tableHeaders.includes('商品信息'));
 assert.deepEqual(capture.detail.productStateQuery.snapshot.totals,[0]);assert.deepEqual(capture.detail.productStateQuery.snapshot.rows,[]);
 assert.equal(capture.detail.productStateQuery.snapshot.empty,false);
},{rows:[],emptyText:'未知空列表占位'}));

for(const width of [960,1440])test(`a picker-missing product is independently confirmed off shelf in all-products at ${width}`,async()=>harness(async({platform,stats})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),error=>error.code==='OFF_SHELF'&&error.detail?.productState?.source==='live-platform-product-management');
 assert.equal(stats().managedVisits,1);assert.deepEqual(stats().managedQueries,[target]);
},{width,rows:[],managedRows:[{id:target,status:'已下架'}]}));

test('an earlier off-shelf result is rechecked live and an available product can proceed',async()=>harness(async({platform,fixture,stats})=>{
 platform.journal={productChecks:()=>[{shopId:'900001',productId:fixtureProducts[0].productId,code:'OFF_SHELF'}],event(){},list:()=>[]};
 const current=await platform.precheck(fixtureProducts[0]);assert.equal(current.complete,true);assert.equal(fixture.state.prechecks,1);
 assert.equal(stats().managedVisits,1);assert.deepEqual(stats().managedQueries,[fixtureProducts[0].productId]);
},{rows:[],managedRows:[{id:fixtureProducts[0].productId,status:'售卖中'}]}));

test('off-shelf labels outside the exact status cell cannot classify a selling product as off shelf',async()=>harness(async({platform,stats})=>{
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),error=>error.code==='NOT_FOUND');
 assert.equal(stats().managedVisits,1);
},{rows:[],managedRows:[{id:target,status:'售卖中'}]}));

test('a managed-product reload during account verification settles within the same bounded read',async()=>harness(async({platform})=>{
 const identify=platform.identity.bind(platform);let managedIdentities=0;
 platform.identity=async page=>{
  const account=await identify(page);
  if(new URL(page.url()).pathname==='/ffa/g/list'&&++managedIdentities===2)await page.evaluate(()=>{
   const spinner=document.createElement('div');spinner.className='ecom-mcenter-spin-spinning';spinner.textContent='加载中';document.body.append(spinner);
   setTimeout(()=>spinner.remove(),650);
  });
  return account;
 };
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),error=>error.code==='OFF_SHELF'&&error.detail.productState.status==='已下架');
},{rows:[],managedRows:[{id:target,status:'已下架'}]}));

for(const code of ['PRODUCT_RECYCLED','NOT_FOUND'])test(`a prior ${code} result is rechecked live before skipping the picker`,async()=>harness(async({platform,fixture,stats})=>{
 platform.journal={productChecks:()=>[{shopId:'900001',productId:target,code}],event(){},list:()=>[]};
 await assert.rejects(platform.precheck({...fixtureProducts[0],productId:target}),e=>e.code==='PRODUCT_RECYCLED');
 assert.equal(fixture.state.prechecks,0);assert.equal(stats().visits,1);
}));

test('a product moved out of recycle can proceed to current SKU precheck',async()=>harness(async({platform,fixture})=>{
 platform.journal={productChecks:()=>[{shopId:'900001',productId:fixtureProducts[0].productId,code:'PRODUCT_RECYCLED'}],event(){},list:()=>[]};
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
