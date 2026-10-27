/* Native DOM, bounded pages and non-overlapping polling keep the UI responsive.
 * Display observations never authorize a price write. */
const $=id=>document.getElementById(id),{token,instance}=window.guardianSession;
import {createPriceReviews} from './price-reviews.js';
import {createMigration} from './migration.js';
import {createRecoveries} from './recoveries.js';
const names={overview:'折扣概览',recoveries:'恢复记录',accounts:'店铺管理',prices:'价格确认',activity:'运行记录',updates:'软件更新'};
const labels={active:'生效中',scheduled:'未开始',missing:'待恢复',pending:'待核实',unconfirmed:'待更新',excluded:'已排除',recycled:'商品已回收'};
const phases={queued:'待准备',prepared:'草稿已核对',submitting:'提交已记录',verifying:'回读中',unknown:'待核实',verified:'回读通过',blocked:'受阻'};
let state=null,catalog=null,view='overview',filter='all',query='',pageIndex=0,pending=false,polling=false,online=false,timer,catalogAt=0,catalogSignature='',activitySignature='',accountSignature='',toastTimer,updateBusy=false,lastUpdate={state:'idle'};
const pageSize=16,expanded=new Set();
let pricePolicySignature='';
let originalRebuildSignature='';
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
const recoveries=createRecoveries({getState:()=>({shopId:state?.shopId??null,visible:view==='recoveries'}),node,money,discount,time});
function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function navigate(next){if(!names[next]||view===next)return;view=next;for(const id of Object.keys(names)){const el=$('view-'+id);el.hidden=id!==view;el.classList.toggle('active',id===view);}
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));text('view-name',names[view]);if(state)render(state);if(view==='overview'&&catalog)renderCatalog(true);if(view==='prices')void priceReviews.refresh();if(view==='recoveries')void recoveries.refresh();window.scrollTo({top:0,behavior:'instant'});}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>navigate(b.dataset.view));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>navigate(b.dataset.go));
function range(values,format){const a=values.filter(Number.isSafeInteger);if(!a.length)return'—';const lo=Math.min(...a),hi=Math.max(...a);return lo===hi?format(lo):format(lo)+' – '+format(hi);}
function renderCatalog(force=false){
 // The server already fingerprints the complete display observation. Searching
 // or changing pages must not stringify every SKU in the store again.
 if(!catalog)return;const signature=JSON.stringify([catalog.revision||catalog,filter,query,pageIndex]);if(!force&&signature===catalogSignature)return;catalogSignature=signature;
 const focused=document.activeElement,focusedProduct=focused?.closest('.product');
 const focusTarget=focused?.tagName==='SUMMARY'&&focusedProduct?{shopId:focusedProduct.dataset.shopId,productId:focusedProduct.dataset.productId,index:[...focusedProduct.querySelectorAll('summary')].indexOf(focused)}:null;
 const c=catalog.counts;text('active-count',c.observedCurrentProducts>0||catalog.complete&&!catalog.stale?c.observedCurrentProducts:'—');text('missing-count',catalog.complete&&!catalog.stale?c.missingProducts:'—');
 text('active-foot',catalog.stale?'读取时间较早，等待更新':catalog.complete?'当前活动已完整读取':'仍有活动待核对');
 text('recovery-failure-summary',c.recoveryFailedProducts?`${c.recoveryFailedProducts} 件商品恢复预查失败，尚未入队提交；展开商品查看原因和重试时间。`:'');$('recovery-failure-summary').hidden=!c.recoveryFailedProducts;
 text('catalog-observation',catalog.observedAt?`读取于 ${time(catalog.observedAt)}${catalog.stale?' · 等待本轮更新':''}${!catalog.complete?' · 全店数据尚未完整':''}`:'登录后自动读取当前活动');
 const needle=query.trim().toLocaleLowerCase(),rows=catalog.products.filter(p=>(filter==='all'||filter==='pending'?filter==='all'||p.pending||p.state==='unconfirmed':p.state===filter)&&(!needle||(p.name+' '+p.productId).toLocaleLowerCase().includes(needle)));
 const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));pageIndex=Math.min(pageIndex,pageCount-1);text('total-label',rows.length+' 件商品');text('page-label',rows.length?`第 ${pageIndex+1} / ${pageCount} 页 · 每页 ${pageSize} 件`:'0 件商品');$('prev-page').disabled=pageIndex===0;$('next-page').disabled=pageIndex===pageCount-1;
 const fragment=document.createDocumentFragment();
 for(const p of rows.slice(pageIndex*pageSize,(pageIndex+1)*pageSize)){
  const detail=node('details','product'),summary=node('summary','product-summary');detail.dataset.productId=p.productId;detail.dataset.shopId=catalog.shopId;
  const title=node('div','product-title'),initial=node('span','product-mark',(p.name||'商品').replace(/^适配|适用/,'').slice(0,1)),titleBody=node('div');titleBody.append(node('strong','',p.name||'商品 '+p.productId),node('small','',p.productId));title.append(initial,titleBody);
  const failureLabel=p.recoveryFailure?.code==='REBUILD_REVIEW_REQUIRED'?'重建待确认':p.recoveryFailure?.stage==='pricing'?'价格待确认':p.recoveryFailure?.stage==='eligibility'?'恢复依据待核验':'预查失败';
  if(p.recoveryFailure)titleBody.append(node('small','reason',failureLabel+' · '+friendly(p.recoveryFailure.message)));
  const lastOnly=!p.current.length&&p.state==='unconfirmed'&&p.lastObserved?.length>0,shown=lastOnly?p.lastObserved:p.current,skus=shown.flatMap(a=>a.skus),price=node('span','price',range(skus.map(s=>s.saleFen),money));
  if(lastOnly)price.append(node('small','last-price-note','上次读取 '+time(Math.min(...shown.map(a=>a.observedAt)))));
  summary.append(title,price,node('span','discount',range(skus.map(s=>s.discount),discount)),badge(p.recoveryFailure?failureLabel:labels[p.state],p.recoveryFailure?'amber':p.state==='active'?'green':p.state==='missing'?'amber':p.state==='pending'?'purple':'neutral'),icon('chevron'));
  detail.append(summary);let populated=false;const populate=()=>{if(populated)return;populated=true;const inner=node('div','sku-detail');
   const addActivity=(a,title)=>{inner.append(node('h3','',title+' · '+(a.campaignId||'')));const table=node('table','sku-table'),head=node('thead'),tr=node('tr');for(const h of ['规格','原价','折后价','折扣'])tr.append(node('th','',h));head.append(tr);table.append(head);const body=node('tbody');for(const s of a.skus){const row=node('tr');for(const cell of [s.name||s.id,money(s.baseFen),money(s.saleFen),discount(s.discount)])row.append(node('td','',cell));body.append(row);}table.append(body);inner.append(table);if(a.skus.some(s=>s.saleSource==='computed-from-verified-base-and-discount'))inner.append(node('p','detail-note','部分折后价由已核对的原价 × 折扣计算。'));};
   for(const a of p.current)addActivity(a,p.stale?'上次读到的活动（待刷新）':'当前活动');for(const a of p.scheduled)addActivity(a,'即将开始');
   if(lastOnly){inner.append(node('p','detail-note','以下为上次读取的价格，正在重新核对，不能代表当前仍然生效。'));for(const a of p.lastObserved)addActivity(a,'上次读取 '+time(a.observedAt));}
   if(!p.current.length&&!p.scheduled.length)inner.append(node('p','detail-note','当前折后价尚未确认，历史价格仅供对照。'));
   if(p.history){const history=node('details'),hs=node('summary','detail-note','查看完整历史规格');history.append(hs);history.addEventListener('toggle',()=>{if(history.open&&!history.dataset.loaded){history.dataset.loaded='1';const box=node('div');const before=inner.childNodes.length;addActivity(p.history,'历史折扣');for(const child of [...inner.childNodes].slice(before))box.append(child);history.append(box);}});inner.append(history);}
   if(p.reason)inner.append(node('div','reason',friendly(p.reason)));
   if(!p.excluded&&!p.pending&&!p.current.length&&!p.scheduled.length&&p.history){
    const request=node('button','button small secondary','立即核验恢复');request.disabled=!online||state?.connection?.shopId!==catalog.shopId||!state?.originalRestoreAuthorized;
    request.onclick=async()=>{request.disabled=true;try{await post('recovery/request',{shopId:catalog.shopId,productId:p.productId});toast('已加入优先恢复队列，当前读取收尾后立即核验；价格变更仍需确认。');}catch(error){toast(error.message);}finally{request.disabled=false;}};inner.append(request);
   }
   if(p.recoveryFailure){
    const f=p.recoveryFailure;inner.append(node('p','detail-note',`最近预查失败：${time(f.at)} · ${f.code} · ${f.submission}`));
    inner.append(node('p','detail-note',f.retryAt?`重试最早时间：${time(f.retryAt)}；需守护运行且当前仍满足恢复条件。`:'等待下一轮核查恢复条件'));
    if(f.stage==='pricing'){const go=node('button','button small secondary','打开价格确认');go.onclick=()=>navigate('prices');inner.append(go);}
    if(f.limitedLoss){const l=f.limitedLoss;inner.append(node('p','detail-note',`核对来源活动：${l.referenceCampaignId||'尚未找到'} · ${l.status||'状态未核实'}；开始 ${time(l.startAt)}；结束 ${time(l.endAt)}`));
     inner.append(node('p','detail-note',`恢复依据：${l.branch}；退出表读取 ${time(l.export?.observedAt)}；本商品匹配 ${l.export?.productMatched?'是':'否'}；${l.nextAction||''}`));}
    if(f.capacity?.source==='program-execution-budget'&&[f.capacity.productCount,f.capacity.skuCount,f.capacity.maxProducts,f.capacity.maxSkus].every(Number.isSafeInteger))
     inner.append(node('p','detail-note',`程序执行容量：本次 ${f.capacity.productCount} 件商品、${f.capacity.skuCount} 个当前规格；每批最多 ${f.capacity.maxProducts} 件商品、${f.capacity.maxSkus} 个规格。完整历史保留。`));
    if(f.detail){const d=f.detail,box=node('details'),heading=node('summary','detail-note','查看商品集合与分页诊断');box.append(heading);
     for(const [label,values] of [['目标商品ID',d.targetProductIds],['实际商品ID',d.actualProductIds],['缺失商品ID',d.missingProductIds],['额外商品ID',d.unexpectedProductIds],['重复商品ID',d.duplicateProductIds]])box.append(node('p','detail-note',label+'：'+(values?.join('、')||'无')));
     box.append(node('p','detail-note',`数量：目标 ${d.targetCount}，实际 ${d.actualCount}，实际去重 ${d.actualUniqueCount}；页面数量 ${JSON.stringify(d.snapshot?.counts||[])}；分页 ${JSON.stringify(d.snapshot?.pagination||{page:d.snapshot?.page})}`));inner.append(box);
    }
   }
   detail.append(inner);
  };
  detail.ontoggle=()=>{if(detail.open){expanded.add(p.productId);populate();}else expanded.delete(p.productId);};
  if(expanded.has(p.productId)){detail.open=true;populate();}fragment.append(detail);
 }
 if(!rows.length){const empty=node('div','empty');empty.append(node('strong','',catalog.products.length?'没有符合条件的商品':state?.shopId?'正在同步店铺折扣':'连接你的第一家店铺'),node('span','',catalog.products.length?'试试其他搜索词或状态。':'完成登录后，商品、折扣和规格价格会自动显示在这里。'));fragment.append(empty);}
 $('products').replaceChildren(fragment);
 // Refreshing observations can replace the focused summary. Restore only the
 // same shop/product control, without stealing focus from search or scrolling.
 if(focusTarget?.shopId===catalog.shopId){
  const replacement=[...$('products').children].find(p=>p.dataset.productId===focusTarget.productId);
  replacement?.querySelectorAll('summary')[focusTarget.index]?.focus({preventScroll:true});
 }
}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;pageIndex=0;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));renderCatalog();});
let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{query=$('search').value;pageIndex=0;renderCatalog();},120);};
$('prev-page').onclick=()=>{pageIndex--;renderCatalog();};$('next-page').onclick=()=>{pageIndex++;renderCatalog();};
function renderActivity(s){const signature=JSON.stringify([s.tasks,s.events]);if(signature===activitySignature)return;activitySignature=signature;
 const tasks=document.createDocumentFragment();for(const t of s.tasks||[]){const item=node('div','record'),body=node('div','record-body');body.append(node('strong','',t.title),node('p','',t.products.join('、')),node('p','',t.reason||`独立回读：${t.receipt?.skuCount||0} 个规格`));item.append(badge(phases[t.phase]||t.phase,t.phase==='verified'?'green':t.phase==='blocked'?'amber':'purple'),body,node('time','',time(t.updatedAt)));tasks.append(item);}if(!s.tasks?.length)tasks.append(node('div','empty','尚无恢复任务'));$('tasks').replaceChildren(tasks);
 const events=document.createDocumentFragment();const kinds={'product-blocked':'商品等待处理','control-error':'连接 / 操作提示',verified:'规格回读通过',unknown:'等待平台确认',queued:'已生成恢复任务',submitting:'已记录提交尝试',verifying:'正在独立回读','verification-pending':'继续核实平台结果'};
 for(const e of s.events||[]){const item=node('div','record'),body=node('div','record-body');body.append(node('strong','',kinds[e.kind]||'任务状态更新'),node('p','',friendly(e.detail.message||e.detail.reason||e.detail.productId||'记录已保存')));
  if(e.detail.runtimeBuild?.version)body.append(node('small','detail-note',`发生版本：${e.detail.runtimeBuild.version}${e.detail.runtimeBuild.sourceBuild===s.sourceBuild?' · 当前运行构建':' · 其他运行构建'}`));
  else body.append(node('small','detail-note','此记录未保存发生时的版本，不能归入当前版本错误'));
  item.append(node('span','record-icon blue','·'),body,node('time','',time(e.at)));events.append(item);}if(!s.events?.length)events.append(node('div','empty','新的运行动态会显示在这里'));$('events').replaceChildren(events);
}
function renderAccounts(s){const signature=JSON.stringify([s.accounts,s.shopId,s.running,s.busy,s.action,s.unknown]);if(signature!==accountSignature){accountSignature=signature;const fragment=document.createDocumentFragment();for(const a of s.accounts||[]){const row=node('div','setting-row'),body=node('div');body.append(node('strong','',a.name||'店铺'),node('p','',a.shopId));row.append(body);if(a.shopId===s.shopId)row.append(badge('当前店铺','blue'));else{const b=node('button','button small secondary','切换店铺');b.disabled=!!(s.running||s.busy||s.action||s.unknown);b.onclick=()=>act('accounts/select',{shopId:a.shopId});row.append(b);}fragment.append(row);}if(!s.accounts?.length)fragment.append(node('div','empty','登录后自动添加店铺，无需填写店铺 ID'));$('account-list').replaceChildren(fragment);}
 text('connection',s.loginOpen?'请在专用窗口登录，然后点击“登录完成”':s.authentication?.required?'店铺登录已失效，请重新登录本店；历史折扣和确认方案已保留':s.connection?`已识别 ${s.connection.name||s.name||'店铺'} · ${s.connection.shopId}`:'登录后自动读取店铺名称、当前活动与规格价格');
 text('consent-status',s.originalRestoreAuthorized?'已确认原折扣恢复':'尚未确认');$('consent-wrap').hidden=!!s.originalRestoreAuthorized;text('exclusions',s.excluded?.length?s.excluded.join('、'):'当前没有排除商品');
 const automatic=s.automaticPriceIncreaseEnabled===true,signaturePolicy=JSON.stringify([s.shopId,automatic]);
 if(signaturePolicy!==pricePolicySignature){pricePolicySignature=signaturePolicy;$('price-increase-consent').checked=false;}
 $('price-increase-consent-wrap').hidden=automatic;text('price-increase-status',automatic?'已开启本店自动提价':'等待逐项确认');
 text('price-increase-policy',automatic?'停止自动提价':'开启自动提价');
 const ready=online&&!pending&&!s.action&&s.shopId&&s.connection?.shopId===s.shopId;
 $('price-increase-consent').disabled=!ready;$('price-increase-policy').disabled=!ready||!automatic&&!$('price-increase-consent').checked;
 const rebuild=s.automaticOriginalRebuildEnabled===true,rebuildSignature=JSON.stringify([s.shopId,rebuild]);
 if(rebuildSignature!==originalRebuildSignature){originalRebuildSignature=rebuildSignature;$('original-rebuild-consent').checked=false;}
 $('original-rebuild-consent-wrap').hidden=rebuild;text('original-rebuild-status',rebuild?'已开启，按原设置自动恢复':'未开启');
 text('original-rebuild-policy',rebuild?'停止自动重建':'开启原折扣自动重建');
 $('original-rebuild-consent').disabled=!ready||!s.originalRestoreAuthorized;
 $('original-rebuild-policy').disabled=!ready||!s.originalRestoreAuthorized||!rebuild&&!$('original-rebuild-consent').checked;
}
function render(s){
 if(s.instance&&s.instance!==instance){location.reload();return;}state=s;
 const loginRequired=s.authentication?.required===true||s.lastRun?.code==='LOGIN_REQUIRED'&&!s.action&&!s.running&&!s.authentication;
 $('login-alert').hidden=!loginRequired&&!s.loginOpen;text('login-alert-message',s.loginOpen?'请在专用窗口完成登录，再点击“登录完成”':'店铺登录已失效，守护已暂停；历史折扣与价格确认保留');
 text('reauthenticate',s.loginOpen?'登录完成':'重新登录本店');$('reauthenticate').disabled=pending||!online||!!s.action||!!s.busy||s.running;
 const sessionWarning=s.authentication?.persistentSession?.available===false;$('session-alert').hidden=!sessionWarning;
 if(sessionWarning)text('session-alert',s.authentication.persistentSession.message);
 $('action-alert').hidden=s.lastAction?.ok!==false||!!s.action;if(s.lastAction?.ok===false)text('action-alert',friendly(s.lastAction.message));
 text('shop',s.shopId?(s.name||'店铺')+' · '+s.shopId:'尚未登录店铺');text('avatar',(s.name||'店').slice(0,1));$('shop-dot').classList.toggle('online',!!s.connection&&!loginRequired);
 const desktopVersion=window.guardianDesktop?.version,versionMismatch=!!desktopVersion&&desktopVersion!==s.version;
 text('version','后台 v'+s.version);text('update-version',desktopVersion?'桌面 '+desktopVersion+' · 后台 '+s.version+(versionMismatch?'（后台尚未切换）':''):'后台 '+s.version);text('footer-state',s.running?'守护正在后台运行':'后台已连接');
 text('connection-label',online?(s.running?'后台守护中':'后台已连接'):'正在重新连接');$('connection-dot').classList.toggle('online',online);
 const p=s.progress||{},working=!!(s.action||s.busy);text('run-pill',s.running?'后台守护已开启':working?'正在同步数据':s.connection?'店铺已连接':'等待连接店铺');
 text('hero-title',s.running?'折扣守护，正在进行':working?'正在同步店铺折扣':s.connection?'你的店铺，已准备就绪':'从连接店铺开始');
 text('hero-detail',s.running?'自动巡检当前活动，按本店已确认的价格恢复，并独立核对每个规格。':s.connection?'查看当前商品折扣，确认恢复规则后即可开启后台守护。':'登录一次，自动识别店铺与当前折扣。之后的巡检在后台完成。');
 if(s.campaignRule?.type==='限量抢购')text('hero-detail',`按各商品原折扣分组守护限量抢购 · 每件商品共用 ${s.campaignRule.activityLimit} 件 · ${s.campaignRule.durationMs/86400000} 天 · 自动续期${s.campaignRule.rules.autoRenew?'开启':'关闭'}。`);
 if(s.campaignConversion&&s.campaignConversion.status!=='complete')text('hero-detail',`限量活动迁移中，已核验 ${s.campaignConversion.verified} / ${s.campaignConversion.total} 件。完整历史保留，普通巡检待迁移完成后继续。`);
 text('progress',[s.action,p.stage,Number.isInteger(p.activeRead)&&Number.isInteger(p.activeTotal)?p.activeRead+' / '+p.activeTotal+' 个当前活动':''].filter(Boolean).join(' · ')||(s.running?'等待下一轮巡检':'守护尚未开启'));
 text('schedule','上次成功：'+time(s.lastSuccessfulRun?.finishedAt||(s.lastRun?.ok?s.lastRun.finishedAt:null))+'　'+(working?'本轮进行中':s.nextAt?'下一轮：'+time(s.nextAt):'等待开启'));
 text('patrol-status',working?'同步中':s.running?'自动巡检':'待机');text('unknown-count',s.unknown||0);text('verified',s.verified||0);text('blocked',s.blocked||0);text('nav-count',s.unknown||0);$('nav-count').hidden=!s.unknown;
 const reads=s.readHealth?.active||[],blockedCleanup=s.readHealth?.quarantined===true;
 if(reads.length){
  const op=reads.reduce((a,b)=>a.startedAt<b.startedAt?a:b),remaining=Math.max(0,Math.ceil((op.deadline-Date.now())/1000));
  text('progress',[s.action,p.stage,op.kind+(op.campaignId?' · 活动 '+op.campaignId:''),'步骤 '+op.lastStep,'读取期限剩余 '+remaining+' 秒'].filter(Boolean).join(' · '));
  const age=Math.max(0,Math.floor((Date.now()-(p.at||s.patrolStartedAt||op.startedAt))/1000));
  text('schedule','本轮开始：'+time(s.patrolStartedAt||op.startedAt)+'　业务进度已等待 '+age+' 秒　上次成功：'+time(s.lastSuccessfulRun?.finishedAt));
  if(age>=120){text('patrol-status','读取较慢');text('run-pill','正在等待平台读取');}
 }
 if(blockedCleanup){text('progress','读取已中止，专用浏览器关闭尚未确认。请使用程序工具中的“修复只读后台”。');text('patrol-status','清理待核实');text('run-pill','守护已暂停');}
 if(s.immediateRecovery?.pending&&!s.immediateRecovery.paused&&!loginRequired&&!blockedCleanup){text('run-pill',`优先恢复 ${s.immediateRecovery.pending} 件已请求商品`);text('patrol-status','优先恢复');}
 if(loginRequired){text('progress','平台登录已失效，守护已暂停。请重新登录本店。');text('patrol-status','需要登录');text('run-pill','等待重新登录');text('hero-title','店铺登录已失效');text('hero-detail','重新登录本店后重新核对活动；原有守护、商品历史和确切价格方案保留。');text('footer-state','店铺需要重新登录');text('connection-label','后台在线 · 店铺需登录');$('connection-dot').classList.remove('online');}
 if(!working&&!loginRequired&&!blockedCleanup&&s.lastRun?.ok===false){text('patrol-status','巡检未完成');text('progress',p.stage+' · '+(s.lastRun.message||s.lastRun.code));text('run-pill',s.running?'等待下一轮核对':'守护已暂停');}
 $('login').disabled=pending||!online||working||s.running||!!s.unknown;$('finish-login').disabled=pending||!online||working||s.running||(!s.loginOpen&&!s.shopId);text('finish-login',s.loginOpen?'登录完成':'重新连接');
 $('audit').disabled=pending||!online||working||s.running||!s.shopId;$('start').disabled=pending||!online||working||s.running||!s.connection||loginRequired;
 text('login',s.shopId?'重新登录本店':'登录店铺');$('add-account').disabled=pending||!online||working||s.running||!!s.unknown;
 $('stop').disabled=pending||!online||!(s.running||s.busy);
 text('price-count',s.priceReviewsPending||0);$('price-count').hidden=!s.priceReviewsPending;priceReviews.sync();
 renderAccounts(s);migration.sync();recoveries.sync();if(view==='activity')renderActivity(s);
}
async function post(path,args={}){const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args),signal:AbortSignal.timeout(25000)});const result=await response.json();if(!response.ok)throw Error(result.message||'操作未完成');return result;}
async function act(name,args={}){if(pending)return;if(name==='start'&&!state.originalRestoreAuthorized&&!$('original-consent').checked){navigate('accounts');toast('请先确认本店的原折扣恢复规则，然后开启守护。');$('original-consent').focus();return;}
 pending=true;if(state)render(state);try{await post(name,{...args,...(name==='start'?{originalDiscountConsent:$('original-consent').checked}:{})});toast(name==='login'?'登录窗口正在打开，完成后点击“登录完成”。':name==='stop'?'已请求暂停，正在安全收尾。':'已开始处理');catalogAt=0;}catch(e){toast(e.message);}finally{pending=false;await poll();}}
for(const name of ['finish-login','audit','start','stop'])$(name).onclick=()=>act(name);
$('login').onclick=()=>act('login',state?.shopId?{reauthenticate:true}:{});
$('add-account').onclick=()=>act('login',{newAccount:true});
$('reauthenticate').onclick=()=>act(state?.loginOpen?'finish-login':'login',{reauthenticate:true});
$('price-increase-consent').onchange=()=>{if(state)renderAccounts(state);};
$('price-increase-policy').onclick=()=>{if(!state)return;const enabled=!state.automaticPriceIncreaseEnabled;if(enabled&&!$('price-increase-consent').checked)return;
 void act('price-increase-policy',{shopId:state.shopId,enabled,acceptHigherPricesAndRisk:enabled&&$('price-increase-consent').checked});};
$('original-rebuild-consent').onchange=()=>{if(state)renderAccounts(state);};
$('original-rebuild-policy').onclick=()=>{if(!state)return;const enabled=!state.automaticOriginalRebuildEnabled;if(enabled&&!$('original-rebuild-consent').checked)return;
 void act('original-rebuild-policy',{shopId:state.shopId,enabled,acceptOriginalRebuild:enabled&&$('original-rebuild-consent').checked});};
async function poll(){if(polling||document.hidden)return;polling=true;clearTimeout(timer);try{
 const response=await fetch('/api/status',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('offline');const s=await response.json();online=true;$('offline').hidden=true;render(s);
 if(view==='prices')await priceReviews.refresh();
 if(view==='recoveries')await recoveries.refresh();
 if(!catalog||Date.now()-catalogAt>10000){const response=await fetch('/api/products',{signal:AbortSignal.timeout(10000)});if(response.ok){catalog=await response.json();catalogAt=Date.now();if(view==='overview')renderCatalog();}}
 }catch{online=false;$('offline').hidden=false;text('connection-label','正在重新连接');$('connection-dot').classList.remove('online');if(state)render(state);}
 finally{polling=false;timer=setTimeout(poll,3000);}}
document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('hidden-page',document.hidden);if(document.hidden)clearTimeout(timer);else{catalogAt=0;void poll();}});
function renderUpdate(u){
 lastUpdate=u;
 const message={checking:'正在连接 GitHub…',available:'发现新版本 '+u.release?.version,current:'当前已是最新发布版本',unpublished:'尚未发布可用安装包',downloading:'正在下载并校验更新…',ready:'更新已校验，准备安装',installing:'正在安装，程序将自动重新打开',error:u.message||'检查失败，请稍后再试'};
 const mismatch=window.guardianDesktop?.version&&state?.version&&window.guardianDesktop.version!==state.version;
 text('update-status',u.state==='current'&&mismatch?'桌面安装包已是最新，实际后台仍为 '+state.version+'，后台切换尚未完成':message[u.state]||'点击检查，获取最新版本');$('check-updates').disabled=['checking','downloading','installing'].includes(u.state);
 $('install-update').hidden=u.state!=='available';$('install-update').disabled=updateBusy;
 if(u.release){text('release-notes',u.release.notes||'此版本没有附加说明');$('release-notes').hidden=false;}
 $('download-progress').hidden=u.state!=='downloading';if(u.progress)$('download-progress').value=Math.round(u.progress.received/u.progress.total*100);
}
$('check-updates').onclick=async()=>{if(updateBusy)return;updateBusy=true;renderUpdate({state:'checking'});try{renderUpdate(window.guardianDesktop?await window.guardianDesktop.checkUpdates():await post('updates/check'));}catch(e){renderUpdate({state:'error',message:e.message});}finally{updateBusy=false;renderUpdate(lastUpdate);}};
$('install-update').onclick=async()=>{if(!window.guardianDesktop){toast('请从桌面“抖店折扣守护”打开程序，下载安装更新。');return;}if(updateBusy)return;updateBusy=true;try{renderUpdate(await window.guardianDesktop.installUpdate());}catch(e){renderUpdate({state:'error',message:e.message});}finally{updateBusy=false;renderUpdate(lastUpdate);}};
if(window.guardianDesktop){window.guardianDesktop.onUpdate(renderUpdate);void window.guardianDesktop.updateStatus().then(renderUpdate);}
function closeTools(focus=false){$('app-tools').hidden=true;$('app-tools-toggle').setAttribute('aria-expanded','false');if(focus)$('app-tools-toggle').focus();}
$('app-tools-toggle').onclick=()=>{const open=$('app-tools').hidden;$('app-tools').hidden=!open;$('app-tools-toggle').setAttribute('aria-expanded',String(open));if(open)$('app-tools').querySelector('button').focus();};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('app-tools').hidden){event.preventDefault();closeTools(true);}});
document.addEventListener('click',event=>{if(!event.target.closest('.app-tools-anchor'))closeTools();});
document.querySelector('[data-tool="updates"]').onclick=()=>{closeTools();navigate('updates');};
document.querySelector('[data-tool="refresh"]').onclick=()=>location.reload();
document.querySelector('[data-tool="diagnostics"]').onclick=()=>{closeTools();navigate('activity');$('diagnostics-panel').scrollIntoView({block:'center'});};
$('export-diagnostics').onclick=async()=>{
 if(!state?.shopId){toast('请先选择需要诊断的店铺');return;}
 $('export-diagnostics').disabled=true;text('diagnostics-status','正在整理当前店铺诊断，不会停止守护…');
 try{const result=await post('diagnostics/export',{shopId:state.shopId,includeScreenshots:$('diagnostics-screenshots').checked});
  const f=result.failureSummary,origin=f?`错误记录：当前构建 ${f.currentBuild} 条，其他构建 ${f.otherBuild} 条，来源未记录 ${f.unattributed} 条；正常维护 ${f.normalMaintenance||0} 条，结果待核实 ${f.pendingResults||0} 条。${f.latest?' 最近错误：'+time(f.latest.at)+'。':''}`:'';
  text('diagnostics-status',`已保存：${result.path}（${result.events} 条事件，${result.evidenceFiles} 个故障证据文件${result.skipped?'；部分历史证据缺失或达到上限，详见包内 summary.json':''}）。${origin}将此 ZIP 发来即可排查。`);
  if(window.guardianDesktop?.action)await window.guardianDesktop.action('diagnostics');
 }catch(e){text('diagnostics-status','导出未完成：'+friendly(e.message));}finally{$('export-diagnostics').disabled=false;}
};
if(window.guardianDesktop?.action){document.querySelector('.desktop-tools').hidden=false;for(const button of document.querySelectorAll('[data-desktop-action]'))button.onclick=async()=>{
 try{const action=button.dataset.desktopAction;if(!action.startsWith('zoom-'))closeTools();const result=await window.guardianDesktop.action(action);if(result?.zoom)document.querySelector('[data-desktop-action="zoom-reset"]').textContent=Math.round(result.zoom*100)+'%';}catch(e){toast(e.message||'操作未完成');}
};}
void poll();
