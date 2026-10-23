import {fingerprint,normalizeName,requireThat,GuardError} from './policy.mjs';
import {formSlice,scrollForm} from './platform-snapshot.mjs';

export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read, label, timeout=25000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await read();if(value)return value;await delay(150);}
 throw new GuardError('LOAD_TIMEOUT',label);
}
export function parseDate(value){
 const m=String(value).match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
 requireThat(m,'TIME_FORMAT','平台时间格式未知');return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
}
export function assembleCells(cells,total){
 let end=0,product=null;const products=[];
 for(const cell of [...cells].sort((a,b)=>a.top-b.top)){
  requireThat(Number.isFinite(cell.top)&&Number.isFinite(cell.height)&&cell.height>0&&Math.abs(cell.top-end)<0.6,'VIRTUAL_GAP','规格虚拟列表存在未读区域');
  end=cell.top+cell.height;
  for(const row of cell.rows){
   if(row.kind==='product'){requireThat(row.productId&&!products.some(p=>p.productId===row.productId),'PRODUCT_DUPLICATE','商品行重复或编号缺失');product={...row,skus:[]};products.push(product);}
   if(row.kind==='sku'){requireThat(product,'VIRTUAL_GAP','规格前没有所属商品');product.skus.push({...row,id:null,idSource:'unavailable-in-create-form'});}
  }
 }
 requireThat(Math.abs(total-end)<0.6,'VIRTUAL_GAP','规格列表末尾尚未完整读取');
 for(const p of products){requireThat(p.skus.length,'SKUS_INCOMPLETE','商品规格尚未展开');
  requireThat(new Set(p.skus.map(s=>normalizeName(s.name))).size===p.skus.length,'DUPLICATE_SKU','页面出现同名规格，不能唯一映射');}
 return products;
}
const materialRow=(r,precheck)=>r.kind==='sku'?{
 kind:r.kind,name:r.name,baseFen:r.baseFen,errors:r.errors,offShelf:r.offShelf,...(!precheck?{discount:r.discount,saleFen:r.saleFen}:{}),
}:r.kind==='product'?{kind:r.kind,productId:r.productId,offShelf:r.offShelf,errors:r.errors,
 ...(!precheck&&Object.hasOwn(r,'activityLimit')?{activityLimit:r.activityLimit}:{})}:{kind:r.kind};
async function pass(page,precheck,originalRisk,deadline,check=()=>{}){
 const loading=s=>s.busy&&!(originalRisk&&s.originalRiskReady&&s.formBusy===false);
 check();
 await page.evaluate(scrollForm,0);await delay(250);
 const first=await until(async()=>{check();const s=await page.evaluate(formSlice);return !loading(s)&&s.cells.some(c=>c.rows.some(r=>r.kind==='product'))&&s;},'商品表单未完整加载',Math.max(1,Math.min(25000,deadline-Date.now())));
 requireThat(first.grids<=1&&first.total>0,'VIRTUAL_LAYOUT','商品网格不唯一或高度未知');
 const cells=new Map(),total=first.total;
 for(let step=0;step<4000;step++){
  check();
  requireThat(Date.now()<deadline,'FORM_UNSTABLE','商品表单未能在限定时间内完整稳定读取');
  const s=await page.evaluate(formSlice);
  requireThat(s.total===total&&!loading(s),'VIRTUAL_CHANGED','读取中布局变化，重新完整采集');
  for(const cell of s.cells){
   requireThat(Number.isFinite(cell.top)&&cell.top>=0&&cell.height>0&&cell.top+cell.height<=total+0.6,'VIRTUAL_LAYOUT','未知虚拟行位置');
   const key=fingerprint(cell.rows.map(r=>materialRow(r,precheck))),old=cells.get(cell.top);
   requireThat(!old||old.key===key&&old.height===cell.height,'FORM_CHANGED','规格或价格在完整读取期间变化');
   cells.set(cell.top,{...cell,key});
  }
  const ordered=[...cells.values()].sort((a,b)=>a.top-b.top);let cursor=0;
  for(const cell of ordered){if(Math.abs(cell.top-cursor)>0.6)break;cursor=cell.top+cell.height;}
  if(Math.abs(cursor-total)<0.6)return {snapshot:s,products:assembleCells(ordered,total),cells:ordered};
  await page.evaluate(scrollForm,cursor);await delay(120);
 }
 throw new GuardError('VIRTUAL_LIMIT','规格遍历未完成');
}
export async function moveFormPage(page,snapshot,direction,{deadline=Date.now()+10000,check=()=>{}}={}){
 check();const p=snapshot.pagination;
 requireThat(p?.present&&p.scopeConfirmed&&p.activeCount===1&&p.nextCount===1&&p.previousCount===1,'FORM_PAGING_SCOPE','商品表单分页归属或控件不明确');
 requireThat(!snapshot.dialogs?.length,'FORM_PAGING_OBSTRUCTED','弹窗遮挡商品表单分页，不能穿过弹窗点击');
 requireThat(['next','previous'].includes(direction),'FORM_PAGING_SCOPE','分页方向无效');
 requireThat((direction==='next'?p.nextDisabled:p.previousDisabled)===false,'FORM_PAGING_INCOMPLETE','商品表单目标分页不可用');
 const expected=p.page+(direction==='next'?1:-1),roots=page.locator('.ecom-mcenter-pagination:visible:not(.ecom-mcenter-drawer-open *):not([role="dialog"] *)');
 requireThat(await roots.count()===1,'FORM_PAGING_SCOPE','商品表单分页不能唯一定位');
 const control=roots.locator(`li[title="${direction==='next'?'下一页':'上一页'}"] button`);
 requireThat(await control.count()===1,'FORM_PAGING_SCOPE','商品表单翻页按钮不唯一');
 await control.click({timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
 let result;try{result=await until(async()=>{check();const s=await page.evaluate(formSlice);return !s.busy&&s.pagination?.scopeConfirmed&&s.pagination.page===expected&&s;},'商品表单翻页未前进',Math.max(1,Math.min(5000,deadline-Date.now())));}
 catch(error){if(error.code==='LOAD_TIMEOUT')throw new GuardError('FORM_PAGING_STALLED','商品表单翻页停滞，未取得完整集合');throw error;}
 return result;
}
export async function fitFormPage(page,count,{check=()=>{}}={}){
 check();const before=await page.evaluate(formSlice),p=before.pagination;
 if(!p?.present||p.pageSize>=count)return true;
 requireThat(p.scopeConfirmed,'FORM_PAGING_SCOPE','商品表单分页归属未核对');
 const root=page.locator('.ecom-mcenter-pagination:visible:not(.ecom-mcenter-drawer-open *):not([role="dialog"] *)');
 requireThat(await root.count()===1,'FORM_PAGING_SCOPE','商品表单页容量入口不唯一');
 const select=root.locator('.ecom-mcenter-select');if(await select.count()!==1)return false;
 const item=select.locator('.ecom-mcenter-select-selection-item');
 if(await item.count()!==1||!/^\d+\s*条\s*\/\s*页$/.test((await item.innerText()).trim()))return false;
 await select.locator('.ecom-mcenter-select-selector').click();
 const options=page.locator('.ecom-mcenter-select-dropdown:visible .ecom-mcenter-select-item-option');
 const texts=await options.allInnerTexts(),candidates=texts.map((text,index)=>({text,index,size:Number(text.trim().match(/^(\d+)\s*条\s*\/\s*页$/)?.[1])})).filter(o=>o.size>=count&&o.size<=200).sort((a,b)=>a.size-b.size);
 if(!candidates.length){await page.keyboard.press('Escape');return false;}
 const target=candidates[0];requireThat(candidates.filter(o=>o.size===target.size).length===1,'FORM_PAGING_SCOPE','商品页容量选项不唯一');
 check();await options.nth(target.index).click();
 await until(async()=>{check();const s=await page.evaluate(formSlice);return !s.busy&&s.pagination?.scopeConfirmed&&s.pagination.page===1&&s.pagination.pageSize===target.size&&fingerprint(s.counts)===fingerprint(before.counts);},'商品页容量变更未核对');
 return true;
}
async function completePass(page,precheck,originalRisk,deadline,previousSnapshot,check){
 let s=previousSnapshot;
 if(s?.pagination?.present)while(s.pagination.page>1){check();s=await moveFormPage(page,s,'previous',{deadline,check});}
 let current=await pass(page,precheck,originalRisk,deadline,check);
 if(current.snapshot.pagination?.present&&current.snapshot.pagination.page>1){
  s=current.snapshot;while(s.pagination.page>1)s=await moveFormPage(page,s,'previous',{deadline,check});current=await pass(page,precheck,originalRisk,deadline,check);
 }
 const products=[],cells=[],pages=[],seen=new Set();let firstKey=null;
 const header=v=>({counts:v.counts,mode:v.mode,...(!precheck?{title:v.title,type:v.type,rules:v.rules,dates:v.dates,byDiscount:v.byDiscount,renew:v.renew}:{})});
 for(let n=1;n<=100;n++){
  check();s=current.snapshot;const p=s.pagination;
  const key=fingerprint(header(s));if(firstKey===null)firstKey=key;
  requireThat(firstKey===key,'FORM_CHANGED','跨页读取时商品数量或活动规则变化');
  if(p?.present)requireThat(p.scopeConfirmed&&p.page===n&&p.activeCount===1&&p.nextCount===1&&p.previousCount===1,'FORM_PAGING_SCOPE','商品分页归属或顺序不明确');
  for(const product of current.products){requireThat(!seen.has(product.productId),'PRODUCT_DUPLICATE','跨页出现重复商品，无法证明完整集合');seen.add(product.productId);products.push(product);}
  cells.push(...current.cells.map(c=>({...c,page:n})));pages.push({page:n,productIds:current.products.map(v=>v.productId),cellCount:current.cells.length,total:s.total,pagination:p||null});
  if(!p?.present||p.nextDisabled===true){
   if(p?.present)requireThat(!p.pages?.some(v=>v>n),'FORM_PAGING_INCOMPLETE','下一页已禁用，但仍有声明的后续页');
   return{snapshot:s,products,cells,pageEvidence:pages};
  }
  requireThat(p.nextDisabled===false,'FORM_PAGING_INCOMPLETE','未获得商品表单末页证明');
  if(p.pageSize)requireThat(current.products.length===p.pageSize,'FORM_PAGING_INCOMPLETE','非末页商品数量与页容量不一致');
  await moveFormPage(page,s,'next',{deadline,check});current=await pass(page,precheck,originalRisk,deadline,check);
 }
 throw new GuardError('FORM_PAGING_LIMIT','商品表单分页超过核验上限');
}
export async function collectForm(page,{precheck=false,originalRisk=false,check=()=>{}}={}){
 let previous=null,lastError,materialAttempts=0,layoutRestarts=0,previousSnapshot=null;
 const deadline=Date.now()+180000;
 // Virtual rows can measure their heights only when mounted. Those incomplete
 // traversals do not consume the budget for two equal, complete content reads.
 // Bound geometry convergence separately, without accepting partial coverage.
 while(materialAttempts<5&&layoutRestarts<20&&Date.now()<deadline){
  try{
   check();const value=await completePass(page,precheck,originalRisk,deadline,previousSnapshot,check);previousSnapshot=value.snapshot;materialAttempts++;
   const key=fingerprint({products:value.products.map(p=>({productId:p.productId,offShelf:p.offShelf,
    ...(!precheck&&Object.hasOwn(p,'activityLimit')?{activityLimit:p.activityLimit}:{}),skus:p.skus.map(r=>materialRow(r,precheck))})),
    counts:value.snapshot.counts,page:value.snapshot.page,pages:value.pageEvidence.map(v=>[v.page,v.productIds,v.pagination?.pageSize]),mode:value.snapshot.mode,...(!precheck?{title:value.snapshot.title,type:value.snapshot.type,rules:value.snapshot.rules,dates:value.snapshot.dates,byDiscount:value.snapshot.byDiscount,renew:value.snapshot.renew}: {})});
   if(previous===key)return {...value,traversal:{materialAttempts,layoutRestarts,completePages:value.pageEvidence.map(v=>v.page),pages:value.pageEvidence,cellCount:value.cells.length}};previous=key;
  }catch(e){
   if(!['VIRTUAL_CHANGED','FORM_CHANGED','VIRTUAL_GAP'].includes(e.code))throw e;
   if(e.code==='FORM_CHANGED')materialAttempts++;else layoutRestarts++;
   lastError=e;previous=null;previousSnapshot=null;
  }
 }
 throw lastError||new GuardError('FORM_UNSTABLE','两次完整采集未能一致');
}
export function precheckMembershipDiagnostic(targetProductIds,{products,snapshot,cells=[],traversal=null}){
 const actualProductIds=products.map(p=>p.productId),targets=new Set(targetProductIds),actual=new Set(actualProductIds);
 const missingProductIds=targetProductIds.filter(id=>!actual.has(id)),unexpectedProductIds=actualProductIds.filter(id=>!targets.has(id));
 const duplicateProductIds=[...actual].filter(id=>actualProductIds.filter(x=>x===id).length>1),failedConditions=[];
 if(actualProductIds.length!==targetProductIds.length)failedConditions.push('PRODUCT_COUNT');
 if(duplicateProductIds.length)failedConditions.push('DUPLICATE_PRODUCT_IDS');
 if(missingProductIds.length)failedConditions.push('MISSING_PRODUCT_IDS');
 if(unexpectedProductIds.length)failedConditions.push('UNEXPECTED_PRODUCT_IDS');
 if(!snapshot.counts?.length)failedConditions.push('COUNT_MISSING');
 else if(!snapshot.counts.every(n=>n===targetProductIds.length))failedConditions.push('COUNT_MISMATCH');
 // Paging is diagnostic until the failing shop's DOM establishes which pager
 // owns the form. Do not turn unrelated visible navigation into a new blocker.
 const pagingWarnings=[];
 if(snapshot.pagination?.nextCount===1&&snapshot.pagination.nextDisabled===false)pagingWarnings.push('NEXT_PAGE_VISIBLE');
 if((snapshot.pagerCount||0)>1||(snapshot.pagination?.nextCount||0)>1)pagingWarnings.push('MULTIPLE_PAGERS_VISIBLE');
 return {stage:'precheck',capturedAt:Date.now(),targetProductIds:[...targetProductIds],actualProductIds,missingProductIds,unexpectedProductIds,duplicateProductIds,
  targetCount:targetProductIds.length,actualCount:actualProductIds.length,actualUniqueCount:actual.size,failedConditions,
  snapshot:{counts:[...(snapshot.counts||[])],countDetails:snapshot.countDetails||[],page:snapshot.page,pagerCount:snapshot.pagerCount,
   pagination:snapshot.pagination||null,grids:snapshot.grids,total:snapshot.total,mode:snapshot.mode,busy:snapshot.busy},
  pagingWarnings,cells:cells.map(c=>({page:c.page||snapshot.page,top:c.top,height:c.height,productIds:(c.rows||[]).filter(r=>r.kind==='product').map(r=>r.productId),skuCount:(c.rows||[]).filter(r=>r.kind==='sku').length})),
  traversal:traversal||{cellCount:cells.length},enqueued:false,submitAttempts:0};
}
export function assertPrecheckMembership(targetProductIds,value){
 const d=precheckMembershipDiagnostic(targetProductIds,value);
 if(d.failedConditions.length)throw new GuardError('PRECHECK_MEMBERSHIP',
  `批量预查商品集合不一致：目标${d.targetCount}件，实际${d.actualCount}件，缺失${d.missingProductIds.length}件，额外${d.unexpectedProductIds.length}件；页面数量[${d.snapshot.counts.join(',')}]，第${d.snapshot.page??'未知'}页；失败条件 ${d.failedConditions.join('、')}。尚未入队或提交。`,
  {precheckMembership:d});
 return d;
}
export function bindFormProducts(products,plans){
 requireThat(products.length===plans.length&&products.every(p=>plans.some(q=>q.productId===p.productId)),'DRAFT_MEMBERSHIP','草稿商品集合不一致');
 return products.flatMap(p=>{
  const plan=plans.find(q=>q.productId===p.productId);requireThat(!p.offShelf&&p.skus.length===plan.skus.length,'DRAFT_MEMBERSHIP','草稿规格集合变化');
  return p.skus.map(s=>{const matches=plan.skus.filter(q=>normalizeName(q.name)===normalizeName(s.name));
   requireThat(matches.length===1,'DRAFT_MAPPING','草稿规格不能唯一映射');
   return {...s,productId:p.productId,id:matches[0].id,idSource:'mapped-from-verified-history'};
  });
 });
}
