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
async function pass(page,precheck,originalRisk,deadline){
 const loading=s=>s.busy&&!(originalRisk&&s.originalRiskReady&&s.formBusy===false);
 await page.evaluate(scrollForm,0);await delay(250);
 const first=await until(async()=>{const s=await page.evaluate(formSlice);return !loading(s)&&s.cells.some(c=>c.rows.some(r=>r.kind==='product'))&&s;},'商品表单未完整加载',Math.max(1,Math.min(25000,deadline-Date.now())));
 requireThat(first.grids<=1&&first.total>0,'VIRTUAL_LAYOUT','商品网格不唯一或高度未知');
 const cells=new Map(),total=first.total;
 for(let step=0;step<4000;step++){
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
export async function collectForm(page,{precheck=false,originalRisk=false}={}){
 let previous=null,lastError,materialAttempts=0,layoutRestarts=0;
 const deadline=Date.now()+60000;
 // Virtual rows can measure their heights only when mounted. Those incomplete
 // traversals do not consume the budget for two equal, complete content reads.
 // Bound geometry convergence separately, without accepting partial coverage.
 while(materialAttempts<5&&layoutRestarts<20&&Date.now()<deadline){
  try{
   const value=await pass(page,precheck,originalRisk,deadline);materialAttempts++;
   const key=fingerprint({products:value.products.map(p=>({productId:p.productId,offShelf:p.offShelf,
    ...(!precheck&&Object.hasOwn(p,'activityLimit')?{activityLimit:p.activityLimit}:{}),skus:p.skus.map(r=>materialRow(r,precheck))})),
    counts:value.snapshot.counts,page:value.snapshot.page,mode:value.snapshot.mode,...(!precheck?{title:value.snapshot.title,type:value.snapshot.type,rules:value.snapshot.rules,dates:value.snapshot.dates,byDiscount:value.snapshot.byDiscount,renew:value.snapshot.renew}: {})});
   if(previous===key)return {...value,traversal:{materialAttempts,layoutRestarts,completePages:[value.snapshot.page],cellCount:value.cells.length}};previous=key;
  }catch(e){
   if(!['VIRTUAL_CHANGED','FORM_CHANGED','VIRTUAL_GAP'].includes(e.code))throw e;
   if(e.code==='FORM_CHANGED')materialAttempts++;else layoutRestarts++;
   lastError=e;previous=null;
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
  pagingWarnings,cells:cells.map(c=>({top:c.top,height:c.height,productIds:(c.rows||[]).filter(r=>r.kind==='product').map(r=>r.productId),skuCount:(c.rows||[]).filter(r=>r.kind==='sku').length})),
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
