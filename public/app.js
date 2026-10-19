/* Native DOM, bounded pages and non-overlapping polling keep the UI responsive.
 * Display observations never authorize a price write. */
const $=id=>document.getElementById(id),{token,instance}=window.guardianSession;
import {createPriceReviews} from './price-reviews.js';
import {createMigration} from './migration.js';
const names={overview:'折扣概览',accounts:'店铺管理',prices:'价格确认',activity:'运行记录',updates:'软件更新'};
const labels={active:'生效中',scheduled:'未开始',missing:'待恢复',pending:'待核实',unconfirmed:'待更新',excluded:'已排除'};
const phases={queued:'待准备',prepared:'草稿已核对',submitting:'提交已记录',verifying:'回读中',unknown:'待核实',verified:'回读通过',blocked:'受阻'};
let state=null,catalog=null,view='overview',filter='all',query='',pageIndex=0,pending=false,polling=false,online=false,timer,catalogAt=0,catalogSignature='',activitySignature='',accountSignature='',toastTimer,updateBusy=false,lastUpdate={state:'idle'};
const pageSize=16,expanded=new Set();
const text=(id,value)=>{const el=$(id),t=String(value??'—');if(el.textContent!==t)el.textContent=t;};
const time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'尚无记录';
const money=n=>Number.isSafeInteger(n)?'¥'+(n/100).toFixed(2):'—';
const discount=n=>Number.isSafeInteger(n)?(n/10).toFixed(n%10?1:0)+' 折':'—';
const friendly=value=>/browserType\..*spawn|spawn UNKNOWN/.test(value||'')?'专用浏览器暂时未能启动，请在店铺管理重新连接。':String(value||'').split('\n')[0].slice(0,350);
function node(tag,className,value){const n=document.createElement(tag);if(className)n.className=className;if(value!==undefined)n.textContent=value;return n;}
function badge(value,color='neutral'){return node('span','badge '+color,value);}
function icon(name){const s=document.createElementNS('http://www.w3.org/2000/svg','svg'),u=document.createElementNS(s.namespaceURI,'use');u.setAttribute('href','#i-'+name);s.append(u);return s;}
const priceReviews=createPriceReviews({getState:()=>({state,online}),post,toast,node,money,discount,time});
const migration=createMigration({getState:()=>({state,online}),post,toast,node,money,discount,time});
function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function navigate(next){if(!names[next]||view===next)return;view=next;for(const id of Object.keys(names)){const el=$('view-'+id);el.hidden=id!==view;el.classList.toggle('active',id===view);}
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));text('view-name',names[view]);if(state)render(state);if(view==='overview'&&catalog)renderCatalog(true);if(view==='prices')void priceReviews.refresh();window.scrollTo({top:0,behavior:'instant'});}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>navigate(b.dataset.view));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>navigate(b.dataset.go));
function range(values,format){const a=values.filter(Number.isSafeInteger);if(!a.length)return'—';const lo=Math.min(...a),hi=Math.max(...a);return lo===hi?format(lo):format(lo)+' – '+format(hi);}
function renderCatalog(force=false){
 if(!catalog)return;const signature=JSON.stringify([catalog,filter,query,pageIndex]);if(!force&&signature===catalogSignature)return;catalogSignature=signature;
 const c=catalog.counts;text('active-count',c.observedCurrentProducts>0||catalog.complete&&!catalog.stale?c.observedCurrentProducts:'—');text('missing-count',catalog.complete&&!catalog.stale?c.missingProducts:'—');
 text('active-foot',catalog.stale?'读取时间较早，等待更新':catalog.complete?'当前活动已完整读取':'仍有活动待核对');
 text('catalog-observation',catalog.observedAt?`读取于 ${time(catalog.observedAt)}${catalog.stale?' · 等待本轮更新':''}${!catalog.complete?' · 全店数据尚未完整':''}`:'登录后自动读取当前活动');
 const needle=query.trim().toLocaleLowerCase(),rows=catalog.products.filter(p=>(filter==='all'||filter==='pending'?filter==='all'||p.pending||p.state==='unconfirmed':p.state===filter)&&(!needle||(p.name+' '+p.productId).toLocaleLowerCase().includes(needle)));
 const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));pageIndex=Math.min(pageIndex,pageCount-1);text('total-label',rows.length+' 件商品');text('page-label',rows.length?`第 ${pageIndex+1} / ${pageCount} 页 · 每页 ${pageSize} 件`:'0 件商品');$('prev-page').disabled=pageIndex===0;$('next-page').disabled=pageIndex===pageCount-1;
 const fragment=document.createDocumentFragment();
 for(const p of rows.slice(pageIndex*pageSize,(pageIndex+1)*pageSize)){
  const detail=node('details','product'),summary=node('summary','product-summary');detail.dataset.productId=p.productId;
  const title=node('div','product-title'),initial=node('span','product-mark',(p.name||'商品').replace(/^适配|适用/,'').slice(0,1)),titleBody=node('div');titleBody.append(node('strong','',p.name||'商品 '+p.productId),node('small','',p.productId));title.append(initial,titleBody);
  const skus=p.current.flatMap(a=>a.skus);summary.append(title,node('span','price',range(skus.map(s=>s.saleFen),money)),node('span','discount',range(skus.map(s=>s.discount),discount)),badge(labels[p.state],p.state==='active'?'green':p.state==='missing'?'amber':p.state==='pending'?'purple':'neutral'),icon('chevron'));
  detail.append(summary);let populated=false;const populate=()=>{if(populated)return;populated=true;const inner=node('div','sku-detail');
   const addActivity=(a,title)=>{inner.append(node('h3','',title+' · '+(a.campaignId||'')));const table=node('table','sku-table'),head=node('thead'),tr=node('tr');for(const h of ['规格','原价','折后价','折扣'])tr.append(node('th','',h));head.append(tr);table.append(head);const body=node('tbody');for(const s of a.skus){const row=node('tr');for(const cell of [s.name||s.id,money(s.baseFen),money(s.saleFen),discount(s.discount)])row.append(node('td','',cell));body.append(row);}table.append(body);inner.append(table);if(a.skus.some(s=>s.saleSource==='computed-from-verified-base-and-discount'))inner.append(node('p','detail-note','部分折后价由已核对的原价 × 折扣计算。'));};
   for(const a of p.current)addActivity(a,p.stale?'上次读到的活动（待刷新）':'当前活动');for(const a of p.scheduled)addActivity(a,'即将开始');
   if(!p.current.length&&!p.scheduled.length)inner.append(node('p','detail-note','当前折后价尚未确认，历史价格仅供对照。'));
   if(p.history){const history=node('details'),hs=node('summary','detail-note','查看完整历史规格');history.append(hs);history.addEventListener('toggle',()=>{if(history.open&&!history.dataset.loaded){history.dataset.loaded='1';const box=node('div');const before=inner.childNodes.length;addActivity(p.history,'历史折扣');for(const child of [...inner.childNodes].slice(before))box.append(child);history.append(box);}});inner.append(history);}
   if(p.reason)inner.append(node('div','reason',friendly(p.reason)));detail.append(inner);
  };
  detail.ontoggle=()=>{if(detail.open){expanded.add(p.productId);populate();}else expanded.delete(p.productId);};
  if(expanded.has(p.productId)){detail.open=true;populate();}fragment.append(detail);
 }
 if(!rows.length){const empty=node('div','empty');empty.append(node('strong','',catalog.products.length?'没有符合条件的商品':state?.shopId?'正在同步店铺折扣':'连接你的第一家店铺'),node('span','',catalog.products.length?'试试其他搜索词或状态。':'完成登录后，商品、折扣和规格价格会自动显示在这里。'));fragment.append(empty);}
 $('products').replaceChildren(fragment);
}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;pageIndex=0;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));renderCatalog();});
let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{query=$('search').value;pageIndex=0;renderCatalog();},120);};
$('prev-page').onclick=()=>{pageIndex--;renderCatalog();};$('next-page').onclick=()=>{pageIndex++;renderCatalog();};
function renderActivity(s){const signature=JSON.stringify([s.tasks,s.events]);if(signature===activitySignature)return;activitySignature=signature;
 const tasks=document.createDocumentFragment();for(const t of s.tasks||[]){const item=node('div','record'),body=node('div','record-body');body.append(node('strong','',t.title),node('p','',t.products.join('、')),node('p','',t.reason||`独立回读：${t.receipt?.skuCount||0} 个规格`));item.append(badge(phases[t.phase]||t.phase,t.phase==='verified'?'green':t.phase==='blocked'?'amber':'purple'),body,node('time','',time(t.updatedAt)));tasks.append(item);}if(!s.tasks?.length)tasks.append(node('div','empty','尚无恢复任务'));$('tasks').replaceChildren(tasks);
 const events=document.createDocumentFragment();const kinds={'product-blocked':'商品等待处理','control-error':'连接 / 操作提示',verified:'规格回读通过',unknown:'等待平台确认',queued:'已生成恢复任务',submitting:'已记录提交尝试',verifying:'正在独立回读','verification-pending':'继续核实平台结果'};
 for(const e of s.events||[]){const item=node('div','record'),body=node('div','record-body');body.append(node('strong','',kinds[e.kind]||'任务状态更新'),node('p','',friendly(e.detail.message||e.detail.reason||e.detail.productId||'记录已保存')));item.append(node('span','record-icon blue','·'),body,node('time','',time(e.at)));events.append(item);}if(!s.events?.length)events.append(node('div','empty','新的运行动态会显示在这里'));$('events').replaceChildren(events);
}
function renderAccounts(s){const signature=JSON.stringify([s.accounts,s.shopId,s.running,s.busy,s.action,s.unknown]);if(signature!==accountSignature){accountSignature=signature;const fragment=document.createDocumentFragment();for(const a of s.accounts||[]){const row=node('div','setting-row'),body=node('div');body.append(node('strong','',a.name||'店铺'),node('p','',a.shopId));row.append(body);if(a.shopId===s.shopId)row.append(badge('当前店铺','blue'));else{const b=node('button','button small secondary','切换店铺');b.disabled=!!(s.running||s.busy||s.action||s.unknown);b.onclick=()=>act('accounts/select',{shopId:a.shopId});row.append(b);}fragment.append(row);}if(!s.accounts?.length)fragment.append(node('div','empty','登录后自动添加店铺，无需填写店铺 ID'));$('account-list').replaceChildren(fragment);}
 text('connection',s.connection?`已识别 ${s.connection.name||s.name||'店铺'} · ${s.connection.shopId}`:s.loginOpen?'请在专用窗口登录，然后点击“登录完成”':'登录后自动读取店铺名称、当前活动与规格价格');
 text('consent-status',s.originalRestoreAuthorized?'已确认原折扣恢复':'尚未确认');$('consent-wrap').hidden=!!s.originalRestoreAuthorized;text('exclusions',s.excluded?.length?s.excluded.join('、'):'当前没有排除商品');
}
function render(s){
 if(s.instance&&s.instance!==instance){location.reload();return;}state=s;
 $('action-alert').hidden=s.lastAction?.ok!==false||!!s.action;if(s.lastAction?.ok===false)text('action-alert',friendly(s.lastAction.message));
 text('shop',s.shopId?(s.name||'店铺')+' · '+s.shopId:'尚未登录店铺');text('avatar',(s.name||'店').slice(0,1));$('shop-dot').classList.toggle('online',!!s.connection);
 text('version','v'+s.version);text('update-version','当前版本 '+(window.guardianDesktop?.version||s.version));text('footer-state',s.running?'守护正在后台运行':'后台已连接');
 text('connection-label',online?(s.running?'后台守护中':'后台已连接'):'正在重新连接');$('connection-dot').classList.toggle('online',online);
 const p=s.progress||{},working=!!(s.action||s.busy);text('run-pill',s.running?'后台守护已开启':working?'正在同步数据':s.connection?'店铺已连接':'等待连接店铺');
 text('hero-title',s.running?'折扣守护，正在进行':working?'正在同步店铺折扣':s.connection?'你的店铺，已准备就绪':'从连接店铺开始');
 text('hero-detail',s.running?'自动巡检当前活动，按本店已确认的价格恢复，并独立核对每个规格。':s.connection?'查看当前商品折扣，确认恢复规则后即可开启后台守护。':'登录一次，自动识别店铺与当前折扣。之后的巡检在后台完成。');
 text('progress',[s.action,p.stage,Number.isInteger(p.activeRead)&&Number.isInteger(p.activeTotal)?p.activeRead+' / '+p.activeTotal+' 个当前活动':''].filter(Boolean).join(' · ')||(s.running?'等待下一轮巡检':'守护尚未开启'));
 text('schedule','最近完成：'+time(s.lastRun?.finishedAt)+'　'+(working?'本轮进行中':s.nextAt?'下一轮：'+time(s.nextAt):'等待开启'));
 text('patrol-status',working?'同步中':s.running?'自动巡检':'待机');text('unknown-count',s.unknown||0);text('verified',s.verified||0);text('blocked',s.blocked||0);text('nav-count',s.unknown||0);$('nav-count').hidden=!s.unknown;
 $('login').disabled=pending||!online||working||s.running||!!s.unknown;$('finish-login').disabled=pending||!online||working||s.running||(!s.loginOpen&&!s.shopId);text('finish-login',s.loginOpen?'登录完成':'重新连接');
 $('audit').disabled=pending||!online||working||s.running||!s.shopId;$('start').disabled=pending||!online||working||s.running||!s.connection;
 $('stop').disabled=pending||!online||!(s.running||s.busy);
 text('price-count',s.priceReviewsPending||0);$('price-count').hidden=!s.priceReviewsPending;priceReviews.sync();
 renderAccounts(s);migration.sync();if(view==='activity')renderActivity(s);
}
async function post(path,args={}){const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args),signal:AbortSignal.timeout(25000)});const result=await response.json();if(!response.ok)throw Error(result.message||'操作未完成');return result;}
async function act(name,args={}){if(pending)return;if(name==='start'&&!state.originalRestoreAuthorized&&!$('original-consent').checked){navigate('accounts');toast('请先确认本店的原折扣恢复规则，然后开启守护。');$('original-consent').focus();return;}
 pending=true;if(state)render(state);try{await post(name,{...args,...(name==='start'?{originalDiscountConsent:$('original-consent').checked}:{})});toast(name==='login'?'登录窗口正在打开，完成后点击“登录完成”。':name==='stop'?'已请求暂停，正在安全收尾。':'已开始处理');catalogAt=0;}catch(e){toast(e.message);}finally{pending=false;await poll();}}
for(const name of ['login','finish-login','audit','start','stop'])$(name).onclick=()=>act(name);
async function poll(){if(polling||document.hidden)return;polling=true;clearTimeout(timer);try{
 const response=await fetch('/api/status',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('offline');const s=await response.json();online=true;$('offline').hidden=true;render(s);
 if(view==='prices')await priceReviews.refresh();
 if(!catalog||Date.now()-catalogAt>10000){const response=await fetch('/api/products',{signal:AbortSignal.timeout(10000)});if(response.ok){catalog=await response.json();catalogAt=Date.now();if(view==='overview')renderCatalog();}}
 }catch{online=false;$('offline').hidden=false;text('connection-label','正在重新连接');$('connection-dot').classList.remove('online');if(state)render(state);}
 finally{polling=false;timer=setTimeout(poll,3000);}}
document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('hidden-page',document.hidden);if(document.hidden)clearTimeout(timer);else{catalogAt=0;void poll();}});
function renderUpdate(u){
 lastUpdate=u;
 const message={checking:'正在连接 GitHub…',available:'发现新版本 '+u.release?.version,current:'当前已是最新发布版本',unpublished:'尚未发布可用安装包',downloading:'正在下载并校验更新…',ready:'更新已校验，准备安装',installing:'正在安装，程序将自动重新打开',error:u.message||'检查失败，请稍后再试'};
 text('update-status',message[u.state]||'点击检查，获取最新版本');$('check-updates').disabled=['checking','downloading','installing'].includes(u.state);
 $('install-update').hidden=u.state!=='available';$('install-update').disabled=updateBusy;
 if(u.release){text('release-notes',u.release.notes||'此版本没有附加说明');$('release-notes').hidden=false;}
 $('download-progress').hidden=u.state!=='downloading';if(u.progress)$('download-progress').value=Math.round(u.progress.received/u.progress.total*100);
}
$('check-updates').onclick=async()=>{if(updateBusy)return;updateBusy=true;renderUpdate({state:'checking'});try{renderUpdate(window.guardianDesktop?await window.guardianDesktop.checkUpdates():await post('updates/check'));}catch(e){renderUpdate({state:'error',message:e.message});}finally{updateBusy=false;renderUpdate(lastUpdate);}};
$('install-update').onclick=async()=>{if(!window.guardianDesktop){toast('请从桌面“抖店折扣守护”打开程序，下载安装更新。');return;}if(updateBusy)return;updateBusy=true;try{renderUpdate(await window.guardianDesktop.installUpdate());}catch(e){renderUpdate({state:'error',message:e.message});}finally{updateBusy=false;renderUpdate(lastUpdate);}};
if(window.guardianDesktop){window.guardianDesktop.onUpdate(renderUpdate);void window.guardianDesktop.updateStatus().then(renderUpdate);}
void poll();
