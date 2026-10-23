// These functions run only in this application's own dedicated browser.
// They read rendered DOM; they never fetch private APIs or browser storage.
export function formSlice() {
  const text=e=>(e?.innerText||e?.textContent||'').trim();
  const visible=e=>!!e&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const all=(s,r=document)=>[...r.querySelectorAll(s)];
  const money=s=>{const m=String(s).replaceAll(',','').match(/^[¥￥]?(\d+)(?:\.(\d{1,2}))?$/);return m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;};
  const quotaColumns=all('tr').filter(r=>r.querySelector('th')).flatMap(r=>[...r.cells].map((c,i)=>({i,label:text(c).replace(/\s/g,'')})).filter(c=>c.label==='活动限量'));
  const quotaColumn=quotaColumns.length===1?quotaColumns[0].i:-1;
  const warningSelector='[role="alert"],.ecom-mcenter-zform-error,[class*="zform-item-explain-error"],[class*="form-item-explain-error"]';
  const parse=row=>{
    const kind=row.className.includes('index-productRow--')?'product':row.className.includes('index-skuRow--')?'sku':row.className.includes('index-addSkuRow--')?'tail':null;
    if(!kind)return null;
    const info=row.cells[1],infoText=text(info),clone=info?.cloneNode(true);
    if(clone)for(const n of all('[title][aria-hidden="true"]',clone))n.textContent=n.getAttribute('title');
    const labels=all('[role="status"],[class*="-tag"],[class*="index-status"],[class*="index-errorInfo--"]',row).filter(visible).map(text);
    const input=row.querySelector('input[role="spinbutton"]'),name=(clone?.textContent||infoText).split(/原价[：:]/)[0].trim();
    const errors=all(warningSelector,row).filter(visible).map(text).filter(Boolean);
    const displayedSale=money(text(row.cells[2]).match(/折后价[：:]\s*[¥￥]([\d,.]+)/)?.[1]);
    // A rejected SKU can replace its ordinary sale label with an explicit
    // current-price constraint. Read that observed amount, never the bound or
    // a computed fallback. Conflicting evidence must remain unprovable.
    const errorSales=errors.map(s=>s.match(/^单品活动价\s*[¥￥]([\d,.]+)\s*[，,]\s*需[≤≥<>]/)?.[1]).filter(s=>s!==undefined).map(money);
    const prices=[...(displayedSale!==null?[displayedSale]:[]),...errorSales];
    const observedSale=prices.length&&prices.every(p=>p!==null&&p===prices[0])?prices[0]:null;
    return {kind,productId:kind==='product'?infoText.match(/ID[：:]\s*(\d+)/)?.[1]||null:null,name,
      baseFen:money(infoText.match(/原价[：:]\s*[¥￥]([\d,.]+)/)?.[1]),
      discount:input?.value?Math.round(Number(input.value)*10):null,
      saleFen:observedSale,
      ...(kind==='product'&&quotaColumn>=0?{activityLimit:(()=>{const inputs=all('input[role="spinbutton"]',row.cells[quotaColumn]);return inputs.length===1&&/^\d+$/.test(inputs[0].value)?Number(inputs[0].value):null;})()}:{}),
      errors,
      offShelf:labels.some(s=>/^(?:商品状态[：:]\s*)?(?:商品)?已下架[。！!]?\s*$/.test(s))};
  };
  const grids=all('.ReactVirtualized__Grid').filter(visible);
  const grid=grids[0],inner=grid?.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
  const cells=inner?all('[role="gridcell"]',inner).map(e=>({top:Number(e.style.transform.match(/^translateY\(([\d.]+)px\)$/)?.[1]),height:Number.parseFloat(e.style.height),rows:all('tr',e).map(parse).filter(Boolean)})):
    [{top:0,height:1,rows:all('tr').filter(visible).map(parse).filter(Boolean)}];
  const selected=all('input[type="radio"]:checked').map(e=>text(e.closest('label')));
  // The platform decorates a remembered selection with a separate "上次选择"
  // tag. Remove only that observed tag, never an arbitrary text suffix.
  const priceModes=all('th .ecom-mcenter-select-selection-item').filter(visible).map(e=>{
    const clone=e.cloneNode(true);
    for(const tag of all('.ecom-mcenter-sp-tag',clone))if(text(tag)==='上次选择')tag.remove();
    return {raw:text(e),value:text(clone)};
  });
  const title=text(document.querySelector('.market-activity-radio-card-item.active [class*="index-title--"]'));
  const renew=selected.some(label=>/^(?:开启|开启自动续期)(?:推荐)?$/.test(label.replace(/\s/g,'')))?true:
    selected.includes('不开启')?false:title==='限量抢购'?null:false;
  const order=text(document.querySelector('#order_expire_time')?.closest('.ecom-mcenter-select')?.querySelector('.ecom-mcenter-select-selection-item'));
  const countDetails=[...text(document.body).matchAll(/已完成\s*(\d+)\s*\/\s*(\d+)|已选数量\s*(\d+)\s*个/g)]
    .map(m=>({kind:m[3]!==undefined?'selected':'completed',text:m[0],total:Number(m[2]??m[3]),...(m[1]!==undefined?{completed:Number(m[1])}:{})}));
  const counts=countDetails.map(c=>c.total);
  const pager=all('li.ecom-mcenter-pagination-item-active[title]').filter(e=>visible(e)&&!e.closest('.ecom-mcenter-drawer-open'));
  const formControl=e=>visible(e)&&!e.closest('.ecom-mcenter-drawer-open,[role="dialog"]');
  const next=all('li[title="下一页"] button').filter(formControl),prev=all('li[title="上一页"] button').filter(formControl);
  const pagerRoot=pager.length===1?(pager[0].closest('ul,.ecom-mcenter-pagination')||pager[0].parentElement):null;
  const pagerText=text(pagerRoot),disabled=e=>e.disabled||e.getAttribute('aria-disabled')==='true'||e.closest('li')?.getAttribute('aria-disabled')==='true'||/pagination-disabled/.test(e.closest('li')?.className||'');
  const pagination={page:pager.length===1?Number(pager[0].title):null,activeCount:pager.length,nextCount:next.length,
    nextDisabled:next.length===1?!!disabled(next[0]):null,previousCount:prev.length,previousDisabled:prev.length===1?!!disabled(prev[0]):null,
    pageSize:Number(pagerText.match(/(\d+)\s*(?:条|个|件)\s*\/\s*页/)?.[1])||null,total:Number(pagerText.match(/共\s*(\d+)\s*(?:条|个|件)/)?.[1])||null,text:pagerText.slice(0,500)};
  const dialogs=all('[role="dialog"]').filter(visible),busyNodes=all('.ecom-mcenter-spin-spinning,.ecom-mcenter-zform-item-is-validating').filter(visible);
  const riskButtons=dialogs.length===1?all('button',dialogs[0]).filter(e=>visible(e)&&text(e).replace(/\s/g,'')==='仍要创建'&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'):[];
  const originalRiskReady=dialogs.length===1&&/^\d+个商品存在低价风险，请谨慎新建/.test(text(dialogs[0]).replace(/\s/g,''))&&riskButtons.length===1;
  return {title:document.querySelector('#title')?.value||'',type:title,mode:text(document.querySelector('#select_product_method input:checked')?.closest('label')),
    rules:{noLimit:selected.includes('不设置'),noPerUserLimit:selected.includes('不限购'),noWarmup:selected.includes('不预热'),orderMinutes:Number(order.match(/^(\d+)分钟$/)?.[1]),...(title==='限量抢购'?{autoRenew:renew}:{})},
    renew,priceModes,byDiscount:priceModes.length===1&&priceModes[0].value==='打折',
    dates:all('input[placeholder="开始日期"],input[placeholder="结束日期"]').map(e=>e.value),counts,grids:grids.length,total:inner?Number.parseFloat(inner.style.height):1,cells,
    page:pager.length?Number(pager[0].title):1,pagerCount:pager.length,pagination,countDetails,
    busy:busyNodes.length>0,formBusy:busyNodes.some(e=>!e.matches('.ecom-mcenter-spin-spinning')||!e.closest('#marketing-global-spin-portal')),originalRiskReady,
    warnings:all(warningSelector).filter(visible).filter(e=>!e.classList.contains('ecom-mcenter-alert-success')||!/^全部\d+个商品（共\d+个规格）上传成功$/.test(text(e).replace(/\s+/g,''))).map(text).filter(Boolean),
    warningDetails:all(warningSelector).filter(visible).map(e=>({text:text(e),tag:e.tagName,role:e.getAttribute('role'),className:String(e.className)})),
    dialogs:dialogs.map(text),
    visibility:document.visibilityState};
}
export function scrollForm(offset) {
  const grid=[...document.querySelectorAll('.ReactVirtualized__Grid')].find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  if(!grid)return false;
  let parent=grid;
  while(parent&&!(parent.scrollHeight>parent.clientHeight+1&&/auto|scroll/.test(getComputedStyle(parent).overflowY)))parent=parent.parentElement;
  if(parent){const base=grid.getBoundingClientRect().top-parent.getBoundingClientRect().top+parent.scrollTop;parent.scrollTo({top:Math.max(0,base+offset),behavior:'instant'});}
  else window.scrollTo({top:Math.max(0,grid.getBoundingClientRect().top+window.scrollY+offset),behavior:'instant'});
  return true;
}
// Structural evidence, not raw HTML. Never collect scripts, hidden inputs,
// arbitrary attributes, authentication fields, links or browser storage.
export function formStructureSnapshot(){
 const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const all=s=>[...document.querySelectorAll(s)].filter(visible);
 const descriptor=e=>({tag:e.tagName,className:String(e.className).slice(0,300),role:e.getAttribute('role'),disabled:e.disabled===true,readOnly:e.readOnly===true});
 const controls=all('input').filter(e=>e.getAttribute('role')==='spinbutton'||['开始日期','结束日期'].includes(e.getAttribute('placeholder')));
 return {capturedAt:Date.now(),viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},scroll:{x:scrollX,y:scrollY},
  controls:controls.slice(0,200).map(e=>({...descriptor(e),placeholder:e.getAttribute('placeholder'),value:e.value})),controlsTruncated:controls.length>200,
  pagers:all('li[title="下一页"],li[title="上一页"],li.ecom-mcenter-pagination-item-active').slice(0,20).map(e=>({...descriptor(e),title:e.title,text:e.innerText.slice(0,100),parentClass:String(e.parentElement?.className||'').slice(0,300)})),
  grids:all('.ReactVirtualized__Grid').map(e=>({...descriptor(e),height:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop})),
  tableHeaders:all('th').slice(0,40).map(e=>({...descriptor(e),text:e.innerText.slice(0,200)})),
  scope:'visible price/date controls, pagination and grid structure only; not raw page HTML'};
}
export function listSlice() {
  const text=e=>(e?.innerText||e?.textContent||'').trim();
  const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const rows=[...document.querySelectorAll('tr[data-row-key]')].filter(r=>visible(r)&&r.querySelector('[data-btm^="operation_"]'));
  return rows.map(r=>{const cells=[...r.cells],ids=[...new Set([...r.querySelectorAll('[data-btm]')].map(n=>n.getAttribute('data-btm').match(/^operation_(?:edit|copy|detail|data|delete|set_failed)_(\d+)$/)?.[1]).filter(Boolean))];
    return {ids,cells:cells.length,name:text(cells[0]).split('\n')[0],type:text(cells[0]).includes('限时抢购')?'限时抢购':text(cells[0]).includes('限量抢购')?'限量抢购':'普通降价促销',
      times:text(cells[2]).match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/g),status:text(cells[5]).match(/进行中|未开始|已失效|已结束|已作废/)?.[0],risk:/风险商品已剔除/.test(text(cells[5]))};});
}
export function detailSlice({limited=false}={}) {
  const text=e=>(e?.innerText||e?.textContent||'').trim(),body=text(document.body);
  const headerRows=[...document.querySelectorAll('tr')].filter(r=>r.querySelector('th'));
  const quotaColumns=headerRows.flatMap(r=>[...r.cells].map((c,i)=>({i,label:text(c).replace(/\s/g,'')})).filter(c=>c.label==='活动限量'));
  const quotaColumn=quotaColumns.length===1?quotaColumns[0].i:-1;
  const quotaValue=cell=>{const value=text(cell).replaceAll(',','').trim();const match=value.match(/^(?:活动限量[：:]\s*)?(\d+)(?:\s*件)?$/);return match?Number(match[1]):null;};
  const money=s=>{const m=String(s).replaceAll(',','').match(/^(\d+)(?:\.(\d{1,2}))?$/);return m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;};
  const rows=[...document.querySelectorAll('tr[data-row-key]')].filter(r=>/^\d+_/.test(r.getAttribute('data-row-key'))&&/ID[：:]/.test(text(r))&&r.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  const products=rows.map(row=>{
    const info=[...row.cells].find(c=>/ID[：:]\s*\d+/.test(text(c))),productId=text(info).match(/ID[：:]\s*(\d+)/)?.[1],nested=row.nextElementSibling;
    const skus=nested?.querySelector('table')?[...nested.querySelectorAll('tr[data-row-key]')].map(r=>{
      const t=text(r.cells[0]),discount=text(r.cells[1]).match(/^(\d(?:\.\d)?)折$/)?.[1],sale=text(r).match(/折后价[：:]\s*[¥￥]([\d,.]+)/)?.[1];
      return {id:r.getAttribute('data-row-key'),name:t.split(/原价[：:]/)[0].trim(),baseFen:money(t.match(/原价[：:]\s*[¥￥]([\d,.]+)/)?.[1]),discount:discount?Math.round(Number(discount)*10):null,saleFen:money(sale)};
    }):[];
    return {productId,name:text(info).split(/ID[：:]/)[0].trim(),key:row.getAttribute('data-row-key'),expanded:!!nested?.querySelector('table'),skus,
      ...(limited?{activityLimit:quotaColumn>=0?quotaValue(row.cells[quotaColumn]):null}:{}),
      ...(limited?{soldOut:/售罄|已抢光|限量(?:已)?售完|剩余(?:活动)?库存[：:]\s*0/.test(text(row)),
        removalRiskConfirmed:/风险|风控|违规|异常剔除/.test(text(row))&&/已退出活动|自动退出|已剔除/.test(text(row))}:{}),
      removalConfirmed:/已退出活动|自动退出/.test(text(row)),removalAmbiguous:/已退出活动|自动退出/.test(text(nested))&&!/已退出活动|自动退出/.test(text(row))};
  });
  const renewal=body.match(/自动续期\s*(不开启|开启自动续期|已开启|开启)(?:\s|$)/)?.[1];
  return {declared:Number(body.match(/商品数量\s*(\d+)\s*个/)?.[1]),products,
    rules:{noLimit:/是否设置活动限量\s*不设置/.test(body),noPerUserLimit:/每人限购\s*不限购/.test(body),noWarmup:/是否预热\s*不预热/.test(body),orderMinutes:Number(body.match(/订单取消时间\s*(\d+)分钟/)?.[1]),
      ...(limited?{autoRenew:renewal?renewal!=='不开启':null}:{})}};
}

export function accountSlice(){
 const visible=e=>!!e&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const text=e=>(e?.innerText||'').trim();
 const names=[...document.querySelectorAll('[class*="index_userName__"][title]')].filter(visible).map(e=>e.title);
 const fields=[...document.querySelectorAll('[label="店铺ID"][value]')].filter(visible);
 const ids=fields.map(e=>{const value=e.getAttribute('value'),shown=text(e.querySelector('[class*="index_descValueText__"]'))||text(e).replace(/^店铺ID[：:]?\s*/i,'');return value===shown?value:null;}).filter(Boolean);
 if(names.length===1&&!ids.length){
  const tags=[...document.querySelectorAll('div,span,label,p,dt,dd,th,td,tr,dl,li,strong,b')].filter(visible);
  for(const node of tags){const m=text(node).replace(/\s/g,'').match(/^店铺ID[:：]?(\d{3,25})$/i);if(!m)continue;
   let parent=node.parentElement;
   for(let depth=0;parent&&depth<8&&!['BODY','HTML'].includes(parent.tagName);depth++,parent=parent.parentElement){
    const content=text(parent);if(content.length>1500)break;
    if(content.includes('店铺信息')&&content.includes(names[0])){ids.push(m[1]);break;}
   }
  }
 }
 return {names,ids:[...new Set(ids)],login:/登录|login/.test(location.pathname)};
}

export function pagerSlice(){
 const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const next=[...document.querySelectorAll('li[title="下一页"] button')].filter(visible);
 const active=[...document.querySelectorAll('li.ecom-mcenter-pagination-item-active[title]')].filter(visible);
 return {nextCount:next.length,disabled:next[0]?.disabled===true||next[0]?.getAttribute('aria-disabled')==='true',page:active.length===1?Number(active[0].title):null,activeCount:active.length};
}
