const api=window.guardianDesktop;
const text=(id,value)=>document.getElementById(id).textContent=value;
function render(state){
 document.body.classList.toggle('blocked',state.phase==='blocked');
 text('title',state.phase==='blocked'?'后台更新尚未完成':state.phase==='ready'?'后台已切换到新版本':'正在更新守护后台');
 text('message',state.message||'正在核对后台状态');text('expected',state.expectedVersion||api.version);text('actual',state.actualVersion||'正在核对');
 const order=['checking','pausing','taking-over','starting'];
 const ranks={idle:0,checking:0,'waiting-results':1,'waiting-task':1,pausing:1,draining:1,stalled:1,'taking-over':2,stopping:2,starting:3,resuming:3,ready:4};
 const current=ranks[state.phase]??1;
 for(const item of document.querySelectorAll('#steps li')){const rank=order.indexOf(item.dataset.phase);item.classList.toggle('active',rank===current);item.classList.toggle('done',rank<current);}
 const p=state.progress;text('progress',p?`${p.stage||''}${Number.isFinite(p.read)?' · '+p.read+'/'+(p.total??'—'):''}`:'');
 text('timing',`已等待 ${Math.floor((state.elapsedMs||0)/1000)} 秒 · 最长等待 ${Math.floor((state.timeoutMs||300000)/1000)} 秒${state.code?' · '+state.code:''}`);
 document.getElementById('retry').hidden=!['blocked','cancelled'].includes(state.phase);
}
api.onBackendUpgrade(render);void api.backendUpgradeStatus().then(render);
document.getElementById('retry').onclick=async()=>{const button=document.getElementById('retry');button.disabled=true;try{render(await api.retryBackendUpgrade());}catch(error){text('message',error.message);}finally{button.disabled=false;}};
document.getElementById('logs').onclick=()=>api.action('upgrade-records').catch(error=>text('message',error.message));
