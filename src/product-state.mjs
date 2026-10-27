import {id,requireThat,fingerprint} from './policy.mjs';
import {until,delay,parseDate} from './collector.mjs';

export const RECYCLE_PATH='/ffa/g/recycle';
export const MANAGED_PATH='/ffa/g/list';
const SEARCH='请输入商品名称/商品ID/商家编码，多条可用逗号隔开';

// Read only the rendered product table. No product mutation controls are used.
export function recycleSlice(){
 const visible=e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
 const text=e=>(e?.innerText||'').trim(),body=document.body.innerText;
 return{
  path:location.pathname,
  headers:[...document.querySelectorAll('th')].filter(visible).map(e=>text(e).replace(/\s+/g,'')),
  rows:[...document.querySelectorAll('tr[data-row-key]')].filter(visible).map(e=>({key:e.getAttribute('data-row-key'),cells:[...e.querySelectorAll(':scope > td')].map(text)})),
  totals:[...new Set([...body.matchAll(/共\s*(\d+)\s*(?:条|件商品)/g)].map(m=>Number(m[1])))],
  empty:/暂无数据|暂无商品|未查询到|没有找到|当前分类下未找到符合条件的商品/.test(body),
  busy:[...document.querySelectorAll('[aria-busy="true"],[class*="spin-spinning"]')].some(visible)
 };
}

export function proveRecycleSlice(snapshot,{shopId,productId,now=Date.now()}){
 requireThat(snapshot.path===RECYCLE_PATH,'RECYCLE_QUERY_CHANGED','商品状态页面地址发生变化');
 const h=snapshot.headers,index=h.indexOf('商品信息'),timeIndex=h.indexOf('进入回收站时间');
 requireThat(index>=0&&timeIndex>=0&&h.filter(x=>x==='商品信息').length===1&&h.filter(x=>x==='进入回收站时间').length===1&&h.includes('操作'),
  'RECYCLE_LAYOUT','回收站表格结构尚未唯一核对');
 requireThat(!snapshot.busy&&snapshot.totals.length===1,'RECYCLE_INCOMPLETE','回收站查询尚未完整返回');
 if(snapshot.totals[0]===0){requireThat(snapshot.empty&&snapshot.rows.length===0,'RECYCLE_INCOMPLETE','回收站空结果尚未确认');return null;}
 requireThat(snapshot.totals[0]===1&&snapshot.rows.length===1,'RECYCLE_AMBIGUOUS','回收站查询结果不唯一，保留待核实状态');
 const row=snapshot.rows[0],ids=[...(row.cells[index]||'').matchAll(/\bID[：:]\s*(\d{3,25})(?=\s|$)/g)].map(m=>m[1]);
 requireThat(row.cells.length===h.length&&row.key===productId&&ids.length===1&&ids[0]===productId,
  'RECYCLE_AMBIGUOUS','回收站商品编号与查询不一致');
 const enteredText=row.cells[timeIndex].replace(/\s+/g,' ').trim();
 const enteredAt=parseDate(enteredText);
 requireThat(Number.isFinite(enteredAt)&&enteredAt>0&&enteredAt<=now+5000&&new Date(enteredAt+8*3600000).toISOString().slice(0,19).replace('T',' ')===enteredText.replaceAll('/','-'),
  'RECYCLE_INCOMPLETE','进入回收站时间尚未明确读取');
 return{kind:'recycled',source:'live-platform-product-recycle',shopId,productId,observedAt:now,enteredAt,complete:true};
}

export async function inspectRecycledProduct(platform,productId){
 id(productId);platform.check();const page=await platform.open(RECYCLE_PATH);
 try{
  const search=page.getByPlaceholder(SEARCH,{exact:true}),query=page.getByRole('button',{name:'查询',exact:true});
  await search.waitFor();requireThat(await search.count()===1&&await query.count()===1,'RECYCLE_LAYOUT','回收站搜索入口不唯一');
  await search.fill(productId);await query.click();await delay(500);
  let prior=null;
  const snapshot=await until(async()=>{
   platform.check();requireThat(new URL(page.url()).origin===platform.base&&new URL(page.url()).pathname===RECYCLE_PATH&&await search.inputValue()===productId,
    'RECYCLE_QUERY_CHANGED','回收站查询条件已变化');
   const s=await page.evaluate(recycleSlice);
   if(s.busy||s.totals.length!==1||s.totals[0]>1&&!s.rows.every(r=>r.key===productId)||s.rows.some(r=>r.key!==productId)){prior=null;return false;}
   // Two consistent rendered results; a transient empty list is never deletion proof.
   const key=fingerprint(s);if(prior!==key){prior=key;return false;}return s;
  },'回收站查询尚未稳定');
  const account=await platform.identity(page);platform.check();
  requireThat(await search.inputValue()===productId,'RECYCLE_QUERY_CHANGED','回收站查询条件已变化');
  const latest=await page.evaluate(recycleSlice);
  requireThat(fingerprint(latest)===fingerprint(snapshot),'RECYCLE_INCOMPLETE','回收站结果在核对期间变化');
  return proveRecycleSlice(latest,{shopId:account.shopId,productId});
 }catch(error){
  await captureStateFailure(platform,page,productId,error,recycleSlice,'recycle');
  throw error;
 }finally{await page.close();}
}

// The activity picker omits some off-shelf products entirely. Query the exact
// product in the independently rendered all-products table; never use a missing
// picker row or a recycle-empty result as proof that it was taken off shelf.
export function managedProductSlice(){
 const visible=e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
 const text=e=>(e?.innerText||'').trim(),body=document.body.innerText;
 return{path:location.pathname,
  selectedTabs:[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible).map(text),
  headers:[...document.querySelectorAll('th')].filter(visible).map(e=>text(e).replace(/\s+/g,'')),
  rows:[...document.querySelectorAll('tr[data-row-key]')].filter(visible).map(e=>({key:e.getAttribute('data-row-key'),cells:[...e.querySelectorAll(':scope > td')].map(text)})),
  totals:[...new Set([...body.matchAll(/共\s*(\d+)\s*(?:条|件商品)/g)].map(m=>Number(m[1])))],
  empty:/暂无数据|暂无商品|未查询到|没有找到|当前分类下未找到符合条件的商品/.test(body),
  busy:[...document.querySelectorAll('[aria-busy="true"],[class*="spin-spinning"]')].some(visible)};
}
export function proveManagedProductSlice(snapshot,{shopId,productId,now=Date.now()}){
 requireThat(snapshot.path===MANAGED_PATH&&snapshot.selectedTabs?.length===1&&snapshot.selectedTabs[0]==='全部',
  'PRODUCT_QUERY_CHANGED','商品管理尚未选中全部商品分类');
 const h=snapshot.headers,index=h.indexOf('商品信息'),statusIndex=h.indexOf('创建时间');
 requireThat(index>=0&&statusIndex>=0&&h.filter(x=>x==='商品信息').length===1&&h.filter(x=>x==='创建时间').length===1&&h.includes('操作'),
  'PRODUCT_STATE_LAYOUT','商品管理表格及状态列尚未唯一核对');
 requireThat(!snapshot.busy&&snapshot.totals.length===1,'PRODUCT_STATE_INCOMPLETE','商品管理查询尚未完整返回');
 if(snapshot.totals[0]===0){requireThat(snapshot.empty&&snapshot.rows.length===0,'PRODUCT_STATE_INCOMPLETE','商品管理空结果尚未确认');return null;}
 requireThat(snapshot.totals[0]===1&&snapshot.rows.length===1,'PRODUCT_STATE_AMBIGUOUS','商品管理查询结果不唯一');
 const row=snapshot.rows[0],ids=[...(row.cells[index]||'').matchAll(/\bID[：:]\s*(\d{3,25})(?=\s|$)/g)].map(m=>m[1]);
 requireThat(row.cells.length===h.length&&row.key===productId&&ids.length===1&&ids[0]===productId,
  'PRODUCT_STATE_AMBIGUOUS','商品管理编号与当前查询不一致');
 const states=[...row.cells[statusIndex].matchAll(/(?:^|\s)(已下架|售卖中|已售罄|已封禁|审核中|审核驳回|审核通过)(?=\s|$)/g)].map(m=>m[1]);
 requireThat(states.length===1,'PRODUCT_STATE_INCOMPLETE','商品管理的确切上下架状态尚未唯一读取');
 return{kind:states[0]==='已下架'?'off-shelf':'managed-product-state',source:'live-platform-product-management',
  shopId,productId,status:states[0],observedAt:now,complete:true};
}
export async function inspectManagedProduct(platform,productId){
 id(productId);platform.check();const page=await platform.open(MANAGED_PATH);
 try{
  const search=page.getByPlaceholder(SEARCH,{exact:true}),query=page.getByRole('button',{name:'查询',exact:true}),all=page.getByRole('tab',{name:'全部',exact:true});
  await search.waitFor();requireThat(await search.count()===1&&await query.count()===1&&await all.count()===1,'PRODUCT_STATE_LAYOUT','商品管理查询入口不唯一');
  if(await all.getAttribute('aria-selected')!=='true')await all.click();
  await until(async()=>await all.getAttribute('aria-selected')==='true','全部商品分类尚未选中');
  // Switching category clears the old search on the real page.
  await search.fill(productId);await query.click();await delay(500);let prior=null;
  const assertScope=async()=>requireThat(new URL(page.url()).origin===platform.base&&new URL(page.url()).pathname===MANAGED_PATH&&
   await search.inputValue()===productId&&await all.getAttribute('aria-selected')==='true','PRODUCT_QUERY_CHANGED','商品管理查询条件或分类已变化');
  const snapshot=await until(async()=>{
   platform.check();await assertScope();const current=await page.evaluate(managedProductSlice);
   if(current.busy||current.totals.length!==1||current.rows.some(r=>r.key!==productId)){prior=null;return false;}
   const key=fingerprint(current);if(prior!==key){prior=key;return false;}return current;
  },'商品管理查询尚未稳定');
  const account=await platform.identity(page);platform.check();await assertScope();
  const latest=await page.evaluate(managedProductSlice);
  requireThat(fingerprint(latest)===fingerprint(snapshot),'PRODUCT_STATE_INCOMPLETE','商品管理结果在核对期间变化');
  return proveManagedProductSlice(latest,{shopId:account.shopId,productId});
 }catch(error){await captureStateFailure(platform,page,productId,error,managedProductSlice,'managed');throw error;}
 finally{await page.close();}
}
async function captureStateFailure(platform,page,productId,error,slice,kind){
 // The caller's picker page may already be closed. Keep this query's evidence
 // before cleanup; the record is diagnostic only and cannot authorize a write.
 if(!/LOGIN|ACCOUNT|SHOP_MISMATCH/.test(error.code||'')){
  const snapshot=await page.evaluate(slice).catch(()=>null),queryValue=await page.getByPlaceholder(SEARCH,{exact:true}).inputValue().catch(()=>null);
  error.detail={...(error.detail||{}),productStateQuery:{source:'live-platform-product-state-diagnostic',kind,
   productId,expectedShopId:platform.policy?.shopId||null,queryValue,snapshot,observedAt:Date.now(),diagnosticOnly:true}};
 }
 if(typeof platform.fault==='function')await platform.fault(page,productId,'product-state',error).catch(()=>{});
}
