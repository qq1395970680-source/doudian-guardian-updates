import {createServer} from 'node:http';
import {zip} from '../../src/workbook.mjs';

export function removalWorkbook(records){
 const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const rows=[['商品ID','商品名','渠道id','渠道类型','失败原因'],...records.map(r=>[r.productId,r.name,'--','--',r.reason])];
 return zip({'xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+rows.map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,j)=>
  '<c r="'+String.fromCharCode(65+j)+(i+1)+'" t="str"><v>'+escape(v)+'</v></c>').join('')+'</row>').join('')+'</sheetData></worksheet>'});
}

export const fixtureProducts=Array.from({length:7},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'测试商品'+i,
 skus:Array.from({length:10},(_,j)=>({id:String(5000000000000000000n+BigInt(i*10+j)),name:'规格'+j,baseFen:10000+j*100,discount:60}))}));
const history={id:'4000000000000000001',name:'历史活动',type:'限时抢购',status:'已结束',startAt:Date.now()-5*86400000,endAt:Date.now()-3*86400000,products:fixtureProducts};
function date(n){const d=new Date(n+8*3600000);return d.toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');}
export async function fixtureServer({catalogProducts=fixtureProducts,activePickerProducts=[],offShelfPickerProducts=[],detailObservedPrices=false,limited=false,readonlyDates=false,readonlyDurationDays=7,hideDetailRenewal=false,quotaReflowPx=0,cancelDelayMs=0,cancelStaleRow=false,corruptPrice=false,dropAfterSubmit=false,abortBeforeHeaders=false,selectionLoadDelayMs=0,submitLabel='创建',extraSubmitButton=false,emptyLiveAlert=false,globalError='',riskGlobalSpinner=false,riskFormSpinner=false,rememberedPriceMode=false,detailExpandable=false,detailGlobalSwitch=true,skuPriceCaps={},skuPriceFloors={},productPriceSummary='',formPageSize=0,formPagerFault=null,formPageSizeOptions=[10,20,50,100]}={}){
 const rootState={campaigns:[structuredClone({...history,products:catalogProducts})],submits:0,risks:0,uploads:0,prechecks:0,creates:0,modeWarnings:0,seenPrices:[],skuPriceCaps,skuPriceFloors,identity:{shopId:'900001',shopName:'独立测试店铺'}};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('content-type','text/html;charset=utf-8');
  const fixtureCookie=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('guardian-fixture-account='))?.slice('guardian-fixture-account='.length);
  const state=rootState.accounts?.get(fixtureCookie)||rootState;
  if(rootState.accounts&&!rootState.accounts.has(fixtureCookie)){
   if(url.pathname!=='/fixture/login'){res.writeHead(302,{Location:'/fixture/login'});res.end();return;}
   res.end('<!doctype html><p>Local fixture authentication has not been supplied.</p>');return;
  }
  if(url.pathname==='/fixture/submit'){
   let text='';for await(const c of req)text+=c;const data=JSON.parse(text);state.submits++;
   if(data.risk)state.risks++;const campaign={...history,id:String(4000000000000000001n+BigInt(state.submits)),name:data.title,status:'进行中',startAt:data.startAt,endAt:data.endAt,
    ...(data.type==='限量抢购'?{type:data.type,autoRenew:data.autoRenew}:{}),
    products:data.products.map(p=>({...catalogProducts.find(x=>x.productId===p.productId),skus:p.skus,...(data.type==='限量抢购'?{activityLimit:p.activityLimit}:{})}))};
   state.campaigns.push(campaign);
   if(abortBeforeHeaders){req.socket.destroy();return;}
   if(dropAfterSubmit){res.writeHead(200,{'Content-Length':'4096'});res.write('committed');setTimeout(()=>res.destroy(),50);return;}
   res.end('ok');return;
  }
  if(url.pathname==='/fixture/stats'){let text='';for await(const c of req)text+=c;const data=JSON.parse(text);for(const [k,v]of Object.entries(data)){if(k==='seenPrices')state.seenPrices.push(...v);else state[k]=(state[k]||0)+v;}res.end('ok');return;}
  if(url.pathname==='/fixture/removals'){
   const campaign=state.campaigns.find(c=>c.id===url.searchParams.get('id'));
   if(!campaign?.removals){res.statusCode=404;res.end();return;}
   state.removalDownloads=(state.removalDownloads||0)+1;
   res.setHeader('content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
   res.setHeader('content-disposition','attachment; filename="removal.xlsx"');
   res.end(campaign.corruptRemoval?Buffer.from('invalid'):removalWorkbook(campaign.removals));return;
  }
  if(url.pathname==='/fixture/cancel'){let text='';for await(const c of req)text+=c;const data=JSON.parse(text),c=state.campaigns.find(c=>c.id===data.id);if(!c){res.statusCode=404;res.end();return;}c.status='已作废';state.cancelAttempts=(state.cancelAttempts||0)+1;res.end('ok');return;}
  const route=url.pathname.split('/').at(-1),isCreate=route==='create',isDetail=route==='view',isEdit=route==='edit';
  const data=isDetail||isEdit?state.campaigns.find(c=>c.id===url.searchParams.get('id')):null;
  let hideIdentity=false;if(isDetail){state.detailLoads=(state.detailLoads||0)+1;if(state.hideShopIdForDetailLoads>0){state.hideShopIdForDetailLoads--;hideIdentity=true;}}
  const base=`<!doctype html><meta charset="utf-8"><style>body{font:15px sans-serif;color:#111;background:#fff}button,label{display:inline-block;padding:8px;margin:4px}input{padding:8px}table{border-collapse:collapse}td{min-width:100px;padding:5px}#scroll{height:280px;overflow-y:auto}.ReactVirtualized__Grid__innerScrollContainer{position:relative}[role=gridcell]{position:absolute;left:0;right:0}tr.index-skuRow--x td{height:40px}[role=dialog]{position:fixed;inset:20%;overflow:auto;z-index:99;background:white;border:2px solid #222;padding:30px}.exit{animation:out .2s forwards}@keyframes out{to{opacity:0}}.index-goodsDrawer--x{position:fixed;inset:5%;background:white;z-index:50;overflow:auto}</style>
  <div class="index_shopTitle__x"><span class="index_userName__x" title="${state.identity.shopName}">${state.identity.shopName}</span>${hideIdentity?'':`<div label="店铺ID" value="${state.identity.shopId}"><span class="index_descValueText__x">${state.identity.shopId}</span></div>`}</div>`;
  if(isEdit){
   state.renewalReads=(state.renewalReads||0)+1;
   res.end(base+`<div class="market-activity-radio-card-item active"><span class="index-title--x">${data.type}</span></div><input id="title" disabled value="${data.name}"><input placeholder="开始日期" disabled value="${date(data.startAt)}"><input placeholder="结束日期" disabled value="${date(data.endAt)}"><div id="renew_switch_on"><label><input type="radio" disabled name="renew" ${data.autoRenew?'':'checked'}>不开启</label><label><input type="radio" disabled name="renew" ${data.autoRenew?'checked':''}>开启自动续期</label></div><button id="submit">提交</button><script>document.querySelector('#submit').onclick=()=>fetch('/fixture/stats',{method:'POST',body:'{"editWrites":1}'});</script>`);return;
  }
  if(isDetail){
   res.end(base+`<h1>${data.name}</h1><p>商品数量 ${data.products.length} 个</p><p>${data.type==='限量抢购'?(hideDetailRenewal?'':`自动续期 ${data.autoRenew?'开启':'不开启'}`):'是否设置活动限量 不设置'} 每人限购 不限购 是否预热 不预热 订单取消时间 30分钟</p>
   ${data.removals?`<p>该活动中，有部分商品的优惠到手价会导致低价引流风险，已为您自动退出活动，<a href="/fixture/removals?id=${data.id}">点击下载详情</a></p>`:''}
   ${detailExpandable&&detailGlobalSwitch?'<button id="expand-detail" role="switch" aria-checked="false">展开规格</button>':''}
   <table>${data.type==='限量抢购'?'<thead><tr><th>商品</th><th>活动限量</th></tr></thead>':''}${data.products.map(p=>`<tr data-row-key="${p.productId}_0_0"><td>${p.name} ID：${p.productId}${p.removalConfirmed?' 已退出活动':''}${p.removalRiskConfirmed?' 风险商品已剔除':''}${p.soldOut?' 已售罄':''}${detailExpandable?'<button aria-label="展开行" '+(detailGlobalSwitch?'disabled':'')+'>展开</button>':''}</td>${data.type==='限量抢购'?`<td>${p.activityLimit}</td>`:''}</tr><tr><td>${detailExpandable?'<template>':''}<table>${p.skus.map(s=>`<tr data-row-key="${s.id}"><td>${s.name} 原价：¥${s.baseFen/100}</td><td>${s.discount/10}折</td>${detailObservedPrices?`<td>折后价：¥${(Math.floor((s.baseFen*s.discount+99)/100)/100).toFixed(2)}</td>`:''}</tr>`).join('')}</table>${detailExpandable?'</template>':''}</td></tr>`).join('')}</table>
   <script>
   const stats=v=>fetch('/fixture/stats',{method:'POST',body:JSON.stringify(v)});
   function expandRow(button){const template=button.closest('tr').nextElementSibling.querySelector('template');if(template)template.replaceWith(template.content.cloneNode(true));button.remove();}
   for(const row of document.querySelectorAll('[aria-label="展开行"]'))row.onclick=()=>{stats({detailRowExpands:1});expandRow(row);};
   const all=document.querySelector('#expand-detail');if(all)all.onclick=()=>{all.setAttribute('aria-checked','true');stats({detailGlobalExpands:1});setTimeout(()=>document.querySelectorAll('[aria-label="展开行"]').forEach(expandRow),150);};
   </script>`);return;
  }
  if(!isCreate){
   res.end(base+`<input id="title" placeholder="请输入活动名称"><input id="product_id" placeholder="请输入商品ID"><div class="ecom-mcenter-select"><div class="ecom-mcenter-select-selector"><span class="ecom-mcenter-select-selection-item">全部</span></div></div><div class="ecom-mcenter-select-dropdown" style="display:none">${['全部','未开始','进行中','已结束','已失效'].map(s=>'<div class="ecom-mcenter-select-item-option">'+s+'</div>').join('')}</div><button id="reset">重置</button><button id="query">查询</button><table><tbody id="list"></tbody></table><ul><li title="1" class="ecom-mcenter-pagination-item-active">1</li><li title="下一页"><button disabled>下一页</button></li></ul><script>
   const campaigns=${JSON.stringify(state.campaigns.map(c=>({...c,dates:[date(c.startAt),date(c.endAt)]})))},body=document.querySelector('#list');
   const selected=document.querySelector('.ecom-mcenter-select-selection-item'),dropdown=document.querySelector('.ecom-mcenter-select-dropdown');
   document.querySelector('.ecom-mcenter-select-selector').onclick=()=>dropdown.style.display='block';for(const option of dropdown.children)option.onclick=()=>{selected.textContent=option.textContent;dropdown.style.display='none';};
   function draw(){const q=document.querySelector('#product_id').value,title=document.querySelector('#title').value,status=selected.textContent;const rows=campaigns.filter(c=>(!q||c.products.some(p=>p.productId===q))&&(!title||c.name.includes(title))&&(status==='全部'||c.status===status));body.innerHTML=rows.map(c=>'<tr data-row-key="'+c.id+'_x"><td>'+c.name+'<br>'+c.type+'</td><td></td><td>'+c.dates.join('<br>')+'</td><td></td><td></td><td>'+c.status+(c.risk?' 风险商品已剔除':'')+'</td><td></td><td></td><td><a data-btm="operation_detail_'+c.id+'">详情</a>'+(['进行中','未开始'].includes(c.status)?'<button data-btm="operation_set_failed_'+c.id+'">作废</button>':'')+'</td></tr>').join('');if(!rows.length)body.innerHTML='<tr><td>暂无数据</td></tr>';
    for(const b of document.querySelectorAll('[data-btm^="operation_set_failed_"]'))b.onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<p>确定失效活动？</p><p>失效活动将影响商品曝光，您确定失效该活动吗？</p><button>确定</button>';document.body.append(d);d.querySelector('button').onclick=async()=>{const id=b.getAttribute('data-btm').slice('operation_set_failed_'.length);if(${cancelDelayMs}>0){d.remove();await new Promise(r=>setTimeout(r,${cancelDelayMs}));}await fetch('/fixture/cancel',{method:'POST',body:JSON.stringify({id})});d.remove();if(${cancelStaleRow})return;campaigns.find(c=>c.id===id).status='已作废';draw();};};
   }
   document.querySelector('#query').onclick=draw;document.querySelector('#reset').onclick=()=>{document.querySelector('#product_id').value='';document.querySelector('#title').value='';selected.textContent='全部';draw();};draw();</script>`);return;
  }
  res.end(base+`${emptyLiveAlert?'<div role="alert" aria-live="polite"> \n </div>':''}${globalError?'<div role="alert">'+globalError+'</div>':''}
  <div class="market-activity-radio-card-item ${limited?'':'active'}"><span class="index-title--x">限时抢购</span></div>
  ${limited?'<div class="market-activity-radio-card-item active"><span class="index-title--x">限量抢购</span></div>':''}
  <input id="title"><div id="select_product_method"><label><input type="radio" name="mode" checked>在线选择</label><label><input type="radio" name="mode">Excel批量导入</label></div>
  ${limited?'<div id="renew_switch_on"><label><input type="radio" name="renew" value="off" checked>不开启</label><label><input type="radio" name="renew" value="on">开启自动续期 <span>推荐</span></label></div>':'<label><input type="radio" name="limit" checked>不设置</label>'}<label><input type="radio" name="per" checked>不限购</label><label><input type="radio" name="warm" checked>不预热</label>
  <div class="ecom-mcenter-select"><div class="ecom-mcenter-select-selector"><input id="order_expire_time" type="hidden"><span class="ecom-mcenter-select-selection-item">30分钟</span></div></div>
  <input placeholder="开始日期"><input placeholder="结束日期"><button id="dates">近48小时</button><button id="add">添加商品</button><input type="file" accept=".xlsx">
  <button role="switch" aria-checked="false" id="expand">展开所有规格</button><span id="count">已选数量 0 个</span><span id="success" role="alert" class="ecom-mcenter-alert-success"></span>
  <section id="form-products"><table><thead><tr>${limited?'<th>选择</th><th>商品规格</th>':''}<th><span class="ecom-mcenter-select-selection-item"><div>打折${rememberedPriceMode?'<div class="ecom-mcenter-sp-tag ecom-mcenter-sp-tag-wrapper"><div class="sp-tag-content">上次选择</div></div>':''}</div></span></th>${limited?'<th>到手价</th><th>活动限量</th><th>操作</th>':''}</tr></thead></table>
  <div id="scroll"><div class="ReactVirtualized__Grid"><div class="ReactVirtualized__Grid__innerScrollContainer" style="height:1px"></div></div></div>${formPageSize?'<div id="form-pagination"></div>':''}</section><button id="create">${submitLabel}</button>${extraSubmitButton?'<button>创建</button>':''}
  <script>
  const products=${JSON.stringify(catalogProducts)},activePickerProducts=${JSON.stringify(activePickerProducts)},offShelfPickerProducts=${JSON.stringify(offShelfPickerProducts)},caps=${JSON.stringify(state.skuPriceCaps)},floors=${JSON.stringify(state.skuPriceFloors||{})},corrupt=${corruptPrice},limited=${limited},state={selected:[],expanded:false,mode:'online',startAt:0,endAt:0,page:1,pageSize:${formPageSize}};const pagerFault=${JSON.stringify(formPagerFault)};const pageSizeOptions=${JSON.stringify(formPageSizeOptions)};
  const $=s=>document.querySelector(s),stats=v=>fetch('/fixture/stats',{method:'POST',body:JSON.stringify(v)});
  let segments=[];
  function render(){const summary=${JSON.stringify(productPriceSummary)};const height=48;segments=[];let top=0;for(const p of (state.pageSize?state.selected.slice((${JSON.stringify(formPagerFault)}==='duplicate-page'?0:state.page-1)*state.pageSize,(${JSON.stringify(formPagerFault)}==='duplicate-page'?1:state.page)*state.pageSize):state.selected)){const productHeight=height+(p.activityLimit?${quotaReflowPx}:0);segments.push({top,height:productHeight,html:'<tr class="index-productRow--x"><td></td><td>'+p.name+' ID：'+p.productId+(state.mode==='excel'&&summary&&p.skus.some(s=>caps[s.id]!=null&&Math.floor((s.baseFen*s.discount+99)/100)>caps[s.id])?'<div class="ecom-mcenter-zform-error">'+summary+'</div>':'')+'</td><td>折后价：¥60</td></tr>'});top+=productHeight;if(state.expanded)for(const s of p.skus){let error='';if(state.mode==='excel'){const price=Math.floor((s.baseFen*s.discount+99)/100);if(caps[s.id]!=null&&price>caps[s.id])error+='<span class="ecom-mcenter-zform-error">活动价不得高于'+(caps[s.id]/100).toFixed(2)+'元</span>';if(floors[s.id]!=null&&price<floors[s.id])error+='<span class="ecom-mcenter-zform-error">活动价不得低于近15天最低价（'+(floors[s.id]/100).toFixed(2)+'元）</span>';}segments.push({top,html:'<tr class="index-skuRow--x"><td></td><td><span title="'+s.name+'" aria-hidden="true">'+s.name+'</span> 原价：¥'+s.baseFen/100+'</td><td><input role="spinbutton" value="'+s.discount/10+'">折后价：¥'+((Math.floor((s.baseFen*s.discount+99)/100)-(corrupt?1:0))/100)+error+'</td></tr>'});top+=height;}}
   if(state.selected.length){segments.push({top,html:'<tr class="index-addSkuRow--x"><td>末行</td></tr>'});top+=height;}
   $('.ReactVirtualized__Grid__innerScrollContainer').style.height=(top||1)+'px';$('#count').textContent='已选数量 '+state.selected.length+' 个';renderPager();draw();}
  function renderPager(){
   const root=$('#form-pagination');if(!root)return;const pages=Math.max(1,Math.ceil(state.selected.length/state.pageSize));
   root.innerHTML='<ul class="ecom-mcenter-pagination"><li title="上一页" '+(state.page===1?'aria-disabled="true"':'')+'><button '+(state.page===1?'disabled':'')+'>上一页</button></li>'+Array.from({length:pages},(_,i)=>'<li title="'+(i+1)+'" class="ecom-mcenter-pagination-item '+(state.page===i+1?'ecom-mcenter-pagination-item-active':'')+'">'+(i+1)+'</li>').join('')+'<li title="下一页" '+(state.page===pages?'aria-disabled="true"':'')+'><button '+(state.page===pages?'disabled':'')+'>下一页</button></li><li>'+state.pageSize+' 条/页</li></ul>';
   for(const [title,delta] of [['下一页',1],['上一页',-1]])root.querySelector('[title="'+title+'"] button').onclick=()=>{stats({formPageMoves:1});if(pagerFault==='no-advance')return;state.page+=delta;$('#scroll').scrollTop=0;render();};
   if(pageSizeOptions.length){const li=document.createElement('li');li.innerHTML='<div class="ecom-mcenter-select"><div class="ecom-mcenter-select-selector"><span class="ecom-mcenter-select-selection-item">'+state.pageSize+' 条/页</span></div></div>';root.querySelector('ul').append(li);
    li.querySelector('.ecom-mcenter-select-selector').onclick=()=>{const options=document.createElement('div');options.className='ecom-mcenter-select-dropdown';options.innerHTML=pageSizeOptions.map(size=>'<div class="ecom-mcenter-select-item-option">'+size+' 条/页</div>').join('');document.body.append(options);for(const option of options.children)option.onclick=()=>{state.pageSize=Number(option.textContent.match(/[0-9]+/)[0]);state.page=1;options.remove();$('#scroll').scrollTop=0;stats({formPageSizeChanges:1});render();};};
   }

  }
  function draw(){const y=$('#scroll').scrollTop;$('.ReactVirtualized__Grid__innerScrollContainer').innerHTML=segments.filter(s=>s.top+(s.height||48)>Math.max(0,y-100)&&s.top<y+500).map(s=>'<div role="gridcell" style="transform:translateY('+s.top+'px);height:'+(s.height||48)+'px"><table>'+s.html+'</table></div>').join('');
   if(limited)for(const row of document.querySelectorAll('tr.index-productRow--x')){
    const pid=row.cells[1].textContent.match(/ID：([0-9]+)/)[1],p=state.selected.find(p=>p.productId===pid);
    row.cells[2].insertAdjacentHTML('afterbegin','<input role="spinbutton" value="6">');
    row.insertCell().textContent='';const cell=row.insertCell();cell.innerHTML='<input role="spinbutton" step="1" placeholder="请输入" value="'+(p.activityLimit??'')+'">';
    cell.querySelector('input').oninput=e=>{p.activityLimit=Number(e.target.value);if(${quotaReflowPx})setTimeout(render,0);};
   }
  }
  $('#scroll').onscroll=draw;
  $('#expand').onclick=()=>{state.expanded=!state.expanded;$('#expand').setAttribute('aria-checked',String(state.expanded));render();};
  $('#dates').onclick=()=>{state.startAt=Math.floor(Date.now()/1000)*1000;state.endAt=state.startAt+48*3600000;const f=n=>new Date(n+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');$('input[placeholder="开始日期"]').value=f(state.startAt);$('input[placeholder="结束日期"]').value=f(state.endAt);};
  if(limited){state.startAt=Math.floor(Date.now()/1000)*1000;state.endAt=state.startAt+7*86400000;const f=n=>new Date(n+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');$('input[placeholder="开始日期"]').value=f(state.startAt);$('input[placeholder="结束日期"]').value=f(state.endAt);}
  if(limited&&${readonlyDates}){
   const inputs=document.querySelectorAll('input[placeholder$="日期"]');for(const input of inputs)input.readOnly=true;
   state.endAt=state.startAt+86400000;const f=n=>new Date(n+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');inputs[1].value=f(state.endAt);
   const picker=document.createElement('div');picker.className='ecom-mcenter-picker-dropdown';picker.hidden=true;picker.innerHTML='<a>近7天</a><table><tr><td class="ecom-mcenter-picker-cell ecom-mcenter-picker-cell-in-view" title="'+f(state.startAt+${readonlyDurationDays}*86400000).slice(0,10).replaceAll('/','-')+'">结束日期</td></tr></table><button>确定</button>';document.body.append(picker);
   for(const input of inputs)input.onclick=()=>picker.hidden=false;let chosen=0;picker.querySelector('a').onclick=()=>chosen=7;picker.querySelector('td').onclick=()=>chosen=${readonlyDurationDays};
   picker.querySelector('button').onclick=()=>{if(!chosen)return;state.endAt=state.startAt+chosen*86400000;inputs[0].value=f(state.startAt);inputs[1].value=f(state.endAt);picker.hidden=true;stats({datePickerCommits:1});};
  }
  for(const field of document.querySelectorAll('input[placeholder$="日期"]'))field.onchange=()=>{state.startAt=Date.parse($('input[placeholder="开始日期"]').value.replaceAll('/','-').replace(' ','T')+'+08:00');state.endAt=Date.parse($('input[placeholder="结束日期"]').value.replaceAll('/','-').replace(' ','T')+'+08:00');};
  $('#select_product_method').onchange=()=>{if(state.selected.length){stats({modeWarnings:1});throw Error('Must not switch an online-selected draft');}state.mode='excel';};
  const expandControl=$('#expand');if(${selectionLoadDelayMs})expandControl.remove();
  $('#add').onclick=()=>{stats({prechecks:1});const d=document.createElement('div');d.className='ecom-mcenter-drawer-open index-goodsDrawer--x';d.innerHTML='<table>'+products.map(p=>'<tr><td>'+p.name+' 商品ID：'+p.productId+(offShelfPickerProducts.includes(p.productId)?' 已下架':activePickerProducts.includes(p.productId)?' 当前已参与单品直降':'')+'</td><td><input type="checkbox" data-id="'+p.productId+'" '+(activePickerProducts.includes(p.productId)||offShelfPickerProducts.includes(p.productId)?'disabled':'')+'></td></tr>').join('')+'</table><button id="pick">确 定</button><li title="下一页"><button disabled>下一页</button></li>';document.body.append(d);$('#pick').onclick=()=>{state.selected=[...d.querySelectorAll('input:checked')].map(i=>structuredClone(products.find(p=>p.productId===i.dataset.id)));d.classList.add('exit');d.addEventListener('animationend',()=>{d.remove();if(${selectionLoadDelayMs}){const busy=document.createElement('div');busy.className='ecom-mcenter-spin-spinning';busy.textContent='正在加载规格信息，需要一定的加载时间，请耐心等待';document.body.append(busy);setTimeout(()=>{busy.remove();$('#count').before(expandControl);render();},${selectionLoadDelayMs});}else render();},{once:true});};};
  $('input[type=file]').onchange=async e=>{
   const bytes=new Uint8Array(await e.target.files[0].arrayBuffer()),v=new DataView(bytes.buffer);let at=0,xml='';
   while(v.getUint32(at,true)===0x04034b50){const size=v.getUint32(at+18,true),nameSize=v.getUint16(at+26,true),extra=v.getUint16(at+28,true),name=new TextDecoder().decode(bytes.slice(at+30,at+30+nameSize));const dataAt=at+30+nameSize+extra;if(name==='xl/worksheets/sheet1.xml')xml=new TextDecoder().decode(bytes.slice(dataAt,dataAt+size));at=dataAt+size;}
   const doc=new DOMParser().parseFromString(xml,'application/xml'),rows=[...doc.querySelectorAll('row')].slice(1),map=new Map();
   for(const row of rows){const c=[...row.querySelectorAll('c')],pid=c[0].textContent,sid=c[1].textContent,discount=Math.round(Number(c[2].textContent)*100),p=products.find(x=>x.productId===pid),sku=p.skus.find(x=>x.id===sid);if(!map.has(pid))map.set(pid,{productId:pid,name:p.name,skus:[]});map.get(pid).skus.push({...sku,discount});}
   state.selected=[...map.values()];stats({uploads:1,seenPrices:state.selected.flatMap(p=>p.skus.map(s=>({productId:p.productId,id:s.id,discount:s.discount})))});$('#success').textContent='全部'+map.size+'个商品（共'+rows.length+'个规格）上传成功';render();};
  $('#create').onclick=()=>{stats({creates:1});const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>'+state.selected.length+'个商品存在低价风险，请谨慎新建</h2><p>预估最低到手价</p>'+state.selected.map(p=>'<p>ID：'+p.productId+'</p>').join('')+'<button id="risk">仍要创建</button>';document.body.append(d);
   if(${riskGlobalSpinner}){const wait=document.createElement('div');wait.id='marketing-global-spin-portal';wait.style.cssText='position:fixed;inset:0;z-index:50;pointer-events:auto';wait.innerHTML='<div class="index-overlay--fixture"><div class="ecom-mcenter-spin ecom-mcenter-spin-spinning index-spinWrapper--fixture"> </div></div>';document.body.append(wait);$('#create').classList.add('ecom-mcenter-btn-loading');document.body.style.overflow='hidden';document.body.classList.add('ant-scrolling-effect');document.querySelector('[label="店铺ID"]').remove();}
   if(${riskFormSpinner}){const wait=document.createElement('div');wait.id='fixture-form-validation';wait.className='ecom-mcenter-zform-item-is-validating';wait.textContent='正在校验规格';$('#scroll').before(wait);}
   $('#risk').onclick=async()=>{const response=await fetch('/fixture/submit',{method:'POST',body:JSON.stringify({title:$('#title').value,type:limited?'限量抢购':'限时抢购',autoRenew:limited&&$('input[name=renew]:checked').value==='on',startAt:state.startAt,endAt:state.endAt,products:state.selected,risk:true})});await response.text();location.href='/ffa/marketing/tools/limitsales';};};
  render();</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {state:rootState,base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
