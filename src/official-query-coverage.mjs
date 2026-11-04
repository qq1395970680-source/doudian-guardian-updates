import {fingerprint} from './policy.mjs';

const listPath='/ffa/marketing/tools/limitsales',types=['限时抢购','限量抢购'];
const fresh=(at,now)=>Number.isSafeInteger(at)&&at>0&&at<=now+5000&&now-at<=120000;

// This function is self-contained so the dedicated read-only page can evaluate
// it directly. A missing date field alone is never a coverage observation.
export function officialQuerySurfaceSnapshot(){
 const visible=e=>!!e&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const text=e=>(e?.innerText||e?.textContent||'').trim().replace(/\s+/g,' ');
 const all=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
 const inputs=all(document,'input'),titles=inputs.filter(e=>e.placeholder==='请输入活动名称'),products=inputs.filter(e=>e.placeholder==='请输入商品ID');
 const buttonCount=(root,label)=>all(root,'button,[role="button"]').filter(e=>text(e).replace(/\s/g,'')===label).length;
 const labelFor=e=>{const item=e.closest('[class*="form-item"],[class*="FormItem"]');
  const label=item?.querySelector('label,[class*="form-item-label"],[class*="FormItemLabel"]');
  if(label)return text(label).replace(/[：:]$/,'');
  const content=text(item||e.parentElement);return ['活动状态','优惠类型','活动类型'].find(s=>content.startsWith(s))||'';};
 let region=null;
 if(titles.length===1&&products.length===1)for(let node=titles[0].parentElement;node&&!['BODY','HTML'].includes(node.tagName);node=node.parentElement){
  if(!node.contains(products[0])||buttonCount(node,'查询')!==1||buttonCount(node,'重置')!==1)continue;
  const controls=all(node,'.ecom-mcenter-select,select');
  if(controls.filter(e=>labelFor(e)==='活动状态').length!==1)continue;
  // The overview and the list query must have separate, positively located
  // regions. An ancestor spanning the whole workspace is not a query form.
  if(/数据概览/.test(text(node)))break;
  region=node;break;
 }
 if(!region)return {source:'rendered-official-query-surface',pathname:location.pathname,complete:false,reason:'unique-bounded-query-region-not-found'};
 const regionInputs=all(region,'input'),selects=all(region,'.ecom-mcenter-select,select').map(e=>{
  const native=e.tagName==='SELECT',selected=native?e.selectedOptions?.[0]:e.querySelector('.ecom-mcenter-select-selection-item');
  return {label:labelFor(e),kind:native?'native':'ecom',selected:text(selected),placeholder:native?'':text(e.querySelector('.ecom-mcenter-select-selection-placeholder')),
   empty:native?e.value==='':!selected||text(selected)==='',disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'};
 });
 const date=e=>/日期|开始时间|结束时间/.test(e.placeholder||'')||e.type==='date'||e.type==='datetime-local'||!!e.closest('[class*="picker"],[class*="Picker"]');
 const queryDates=regionInputs.filter(date).map(e=>({placeholder:e.placeholder||'',value:e.value.trim(),region:'activity-list-query'}));
 const statisticsDates=[];
 // The live statistics range is rendered as text while its popup inputs are
 // hidden. Read that visible range container, never the hidden input values.
 const rangePattern=/\d{4}[/-]\d{2}[/-]\d{2}\s*[-~至]\s*\d{4}[/-]\d{2}[/-]\d{2}/;
 const rangeContainers=all(document,'[class*="picker"],[class*="Picker"],div,span').filter(e=>!region.contains(e)&&text(e).length<=300&&rangePattern.test(text(e)));
 const statisticsCandidates=[...new Set([...inputs.filter(e=>date(e)&&!region.contains(e)),...rangeContainers])];
 for(const field of statisticsCandidates){
  let holder=null;
  for(let node=field;node&&!['BODY','HTML'].includes(node.tagName);node=node.parentElement){const value=text(node);if(value.length>2500)break;
   if(/数据概览/.test(value)&&/以下数据仅统计.*商品订单数据/.test(value)&&!node.contains(region)){holder=node;break;}}
  if(!holder)continue;
  const context=text(holder),range=context.match(/(\d{4}[/-]\d{2}[/-]\d{2})\s*[-~至]\s*(\d{4}[/-]\d{2}[/-]\d{2})/);
  const entry={source:'separate-order-statistics-region',context:context.match(/数据概览.*?商品订单数据/)?.[0]||context.slice(0,700),range:range?[range[1],range[2]]:null,separateFromQuery:true};
  if(!statisticsDates.some(s=>JSON.stringify(s)===JSON.stringify(entry)))statisticsDates.push(entry);
 }
 const fields=regionInputs.filter(e=>!e.closest('.ecom-mcenter-select')).map(e=>{
  const known=['请输入活动名称','请输入商品ID'].includes(e.placeholder)||date(e);
  return {type:e.type||'text',placeholder:e.placeholder||'',value:known?e.value.trim():null,checked:['radio','checkbox'].includes(e.type)?e.checked:null,recognized:known};
 });
 const tabs=all(region,'[role="tab"]').map(e=>({label:text(e).slice(0,100),selected:e.getAttribute('aria-selected')==='true'}));
 const selectedExtras=all(region,'input[type="radio"]:checked,input[type="checkbox"]:checked').map(e=>({type:e.type,label:text(e.closest('label')).slice(0,100)}));
 return {source:'rendered-official-query-surface',pathname:location.pathname,complete:true,
  queryRegion:{source:'minimal-common-query-ancestor',tag:region.tagName.toLowerCase(),containsStatistics:false,queryButtonCount:buttonCount(region,'查询'),resetButtonCount:buttonCount(region,'重置'),
   titleInputCount:titles.filter(e=>region.contains(e)).length,productInputCount:products.filter(e=>region.contains(e)).length,visibleInputCount:regionInputs.length,
   fields,selects,tabs,selectedExtras,dateControls:queryDates},statisticsDates};
}

const surface=s=>s?.querySurface;
function signature(s){const r=s.queryRegion;return fingerprint({source:s.source,pathname:s.pathname,complete:s.complete,
 queryRegion:{...r,fields:r.fields.map(f=>({...f,value:null})),selects:r.selects.map(f=>f.label==='活动状态'?{...f,selected:'<status>'}:f)},statisticsDates:s.statisticsDates});}
function inspect(s,query){
 const r=s?.queryRegion;
 if(s?.source!=='rendered-official-query-surface'||s.pathname!==listPath||s.complete!==true||r?.source!=='minimal-common-query-ancestor'||r.containsStatistics!==false||
  r.queryButtonCount!==1||r.resetButtonCount!==1||r.titleInputCount!==1||r.productInputCount!==1||!Array.isArray(r.fields)||!Array.isArray(r.selects)||!Array.isArray(r.dateControls)||!Array.isArray(r.tabs)||!Array.isArray(r.selectedExtras))return 'QUERY_REGION_UNPROVEN';
 if(r.selectedExtras.length||r.tabs.some(t=>t.selected&&!/^(全部|全部活动|全部类型)$/.test(t.label)))return 'EXTRA_QUERY_FILTER';
 if(r.fields.some(f=>!f.recognized)||r.fields.filter(f=>f.placeholder==='请输入活动名称').length!==1||r.fields.filter(f=>f.placeholder==='请输入商品ID').length!==1)return 'QUERY_FIELDS_UNPROVEN';
 if(r.fields.find(f=>f.placeholder==='请输入活动名称').value!==(query.title||'')||r.fields.find(f=>f.placeholder==='请输入商品ID').value!==(query.productId||''))return 'QUERY_VALUE_CHANGED';
 if(r.selects.length!==3||r.selects.some(f=>!['活动状态','优惠类型','活动类型'].includes(f.label))||['活动状态','优惠类型','活动类型'].some(label=>r.selects.filter(f=>f.label===label).length!==1))return 'TYPE_CONTROLS_UNPROVEN';
 if(r.selects.find(f=>f.label==='活动状态').selected!==(query.status||'全部'))return 'QUERY_STATUS_CHANGED';
 const unrestricted=f=>f.disabled!==true&&(f.selected==='全部'||f.selected==='全部类型'||f.selected==='全部活动类型'||f.empty===true&&f.selected===''&&f.placeholder==='请选择');
 if(!r.selects.filter(f=>f.label!=='活动状态').every(unrestricted))return 'TYPE_FILTER_RESTRICTED';
 // Empty pairs are usable only when the controls actually belong to this
 // bounded activity query, never to the separately observed statistics area.
 if(r.dateControls.length){
  if(r.dateControls.length!==2||r.dateControls.some(c=>c.region!=='activity-list-query'||c.value!=='')||r.dateControls.filter(c=>/开始|起始/.test(c.placeholder)).length!==1||r.dateControls.filter(c=>/结束|截止/.test(c.placeholder)).length!==1)return 'DATE_FILTER_RESTRICTED';
 }
 return null;
}
function statisticsRange(s){
 if(!Array.isArray(s?.statisticsDates)||s.statisticsDates.length!==1)return null;
 const d=s.statisticsDates[0];
 if(d.source!=='separate-order-statistics-region'||d.separateFromQuery!==true||!/数据概览/.test(d.context)||!/以下数据仅统计.*商品订单数据/.test(d.context)||!Array.isArray(d.range)||d.range.length!==2)return null;
 const parse=(value,end)=>{if(!/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(value))return NaN;const civil=value.replaceAll('/','-');const at=Date.parse(civil+(end?'T23:59:59.999':'T00:00:00.000')+'+08:00');return new Date(at+8*3600000).toISOString().slice(0,10)===civil?at:NaN;};
 const start=parse(d.range[0],false),end=parse(d.range[1],true);return Number.isFinite(start)&&Number.isFinite(end)&&start<=end?{start,end}:null;
}
function checked(listing,now){
 const scope=listing?.queryScope,q=listing?.query;
 if(listing?.complete!==true||!/^\d+$/.test(listing.shopId||'')||!fresh(listing.observedAt,now)||!q||scope?.source!=='live-platform-list-query-scope'||scope.shopId!==listing.shopId||scope.verified!==true||scope.unchanged!==true||!Number.isSafeInteger(scope.pages)||scope.pages<1||!Array.isArray(listing.campaigns))return 'LISTING_UNPROVEN';
 if(!scope.before||!scope.after||fingerprint(surface(scope.before))!==fingerprint(surface(scope.after)))return 'QUERY_SURFACE_CHANGED';
 return inspect(surface(scope.before),q)||inspect(surface(scope.after),q);
}

// A proof binds the complete listing and the DOM evidence. For a query form
// without dates, a separate statistics region AND an actual complete listing
// with older/outside-range activity are required, not mere absent controls.
export function officialQueryCoverage(listing,{referenceListings=[],now=Date.now()}={}){
 const reject=code=>({source:'live-platform-official-query-coverage',complete:false,code,reason:'官方活动查询范围证据尚不完整；保留未知，不据此允许再次提交。'});
 try{
  const error=checked(listing,now);if(error)return reject(error);
  const s=surface(listing.queryScope.after),r=s.queryRegion;
  let witness=null;
  if(!r.dateControls.length){
   const range=statisticsRange(s);if(!range)return reject('STATISTICS_SCOPE_UNPROVEN');
   for(const candidate of [listing,...referenceListings]){
    if(candidate.shopId!==listing.shopId||checked(candidate,now)||signature(surface(candidate.queryScope.after))!==signature(s))continue;
    const row=candidate.campaigns.find(c=>/^\d+$/.test(c.id||'')&&types.includes(c.type)&&Number.isFinite(c.startAt)&&Number.isFinite(c.endAt)&&c.endAt>c.startAt&&(c.endAt<range.start||c.startAt>range.end));
    if(row){witness={listingFingerprint:fingerprint(candidate),campaignId:row.id,startAt:row.startAt,endAt:row.endAt};break;}
   }
   if(!witness)return reject('OUTSIDE_STATISTICS_RANGE_UNOBSERVED');
  }
  const evidence={source:'rendered-official-query-coverage-evidence',querySurface:s,rangeWitness:witness};
  return {source:'live-platform-official-query-coverage',complete:true,shopId:listing.shopId,observedAt:listing.observedAt,listingFingerprint:fingerprint(listing),
   allDates:true,activityTypes:[...types],evidenceFingerprint:fingerprint(evidence),evidence,
   reason:r.dateControls.length?'已完整定位活动查询区并确认该区起止日期均为空、两类类型筛选均未限制。':'已完整定位独立活动查询区，完整控件无日期限制；日期属于独立订单数据概览，另有实际跨统计日期活动作为佐证，两类类型筛选均未限制。'};
 }catch{return reject('QUERY_COVERAGE_INVALID');}
}
