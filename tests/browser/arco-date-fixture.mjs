export function installArcoDateFixture({start,mode}){
 const fmt=t=>new Date(t+28800000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');
 const parse=s=>Date.parse(s.replaceAll('/','-').replace(' ','T')+'+08:00');
 if(!document.querySelector('input[placeholder="开始日期"]'))document.body.innerHTML='<input id="title"><div class="arco-picker-input"><input readonly placeholder="开始日期"></div><div class="arco-picker-input"><input readonly placeholder="结束日期"></div><div class="arco-picker-range-container" hidden></div>';
 const f=[document.querySelector('input[placeholder="开始日期"]'),document.querySelector('input[placeholder="结束日期"]')];
 f.forEach(x=>{x.readOnly=true;if(!x.parentElement.classList.contains('arco-picker-input')){const wrapper=document.createElement('div');wrapper.className='arco-picker-input';x.replaceWith(wrapper);wrapper.append(x);}});
 let p=document.querySelector('.arco-picker-range-container');if(!p){p=document.createElement('div');p.className='arco-picker-range-container';p.hidden=true;document.body.append(p);}
 let range=[start,start+86400000],month=new Date(start+28800000).getUTCFullYear()*12+new Date(start+28800000).getUTCMonth(),side=0;
 window.timeChanges=[];window.navigation=0;window.inputEvents=0;
 const write=()=>range.forEach((t,i)=>f[i].value=fmt(t));write();
 f.forEach((x,i)=>{x.oninput=()=>window.inputEvents++;x.onclick=()=>{side=i;f.forEach((q,j)=>q.parentElement.classList.toggle('arco-picker-input-active',i===j));p.hidden=false;calendar();};});
 const footer=()=>{p.insertAdjacentHTML('beforeend','<button id="anchor">近1天</button><button id="time">选择时间</button><button class="arco-picker-btn-confirm">确定</button>');
 p.querySelector('#anchor').onclick=()=>{range=[start,start+86400000];write();p.hidden=true;};
 p.querySelector('#time').onclick=time;
 p.querySelector('.arco-picker-btn-confirm').onclick=()=>{if(mode==='wrong-final')range[1]+=1000;if(mode==='changed-start')range[0]+=1000;write();p.hidden=true;f[0].onchange?.();};};
 const calendar=()=>{p.innerHTML='';for(let j=0;j<2;j++){
  const m=month+j,y=Math.floor(m/12),mo=m%12+1,box=document.createElement('div');box.className='arco-panel-date-inner';
  box.innerHTML=`<div class="arco-picker-header-value">${y}年${mo}月</div><div class="arco-picker-header-icon"><svg class="arco-icon-${j?'right':'left'}"></svg></div>`;p.append(box);
  box.querySelector('.arco-picker-header-icon').onclick=()=>{window.navigation++;month+=j?1:-1;calendar();};
  for(let d=1;d<=new Date(Date.UTC(y,mo,0)).getUTCDate();d++){
   const cell=document.createElement('div');cell.className='arco-picker-cell arco-picker-cell-in-view'+(mode==='disabled-day'?' arco-picker-cell-disabled':'');cell.textContent=d;box.append(cell);
   cell.onclick=()=>{range[side]=parse(y+'/'+String(mo).padStart(2,'0')+'/'+String(d).padStart(2,'0')+' '+fmt(range[side]).slice(11));write();side=1-side;f.forEach((q,j)=>q.parentElement.classList.toggle('arco-picker-input-active',side===j));};
  }
 }footer();};
 const time=()=>{p.innerHTML='';for(let s=0;s<(mode==='missing-end'?1:2);s++){
  const box=document.createElement('div');box.className='arco-timepicker';box.style.display='inline-flex';p.append(box);
  for(let c=0;c<3;c++){
   const list=document.createElement('div');list.className='arco-timepicker-list';list.style.cssText='height:180px;overflow:auto;width:50px';box.append(list);
   const ul=document.createElement('ul');list.append(ul);for(let v=0;v<(c?60:24);v++){
    const li=document.createElement('li');li.className='arco-timepicker-cell'+(Number(fmt(range[s]).slice(11).split(':')[c])===v?' arco-timepicker-cell-selected':'')+(mode==='disabled-time'&&s===1?' arco-timepicker-cell-disabled':'');li.textContent=String(v).padStart(2,'0');ul.append(li);
    li.onclick=()=>{window.timeChanges.push({side:s,column:c,value:v});if(mode==='ignored-time')return;const parts=fmt(range[s]).slice(11).split(':');parts[c]=li.textContent;range[s]=parse(fmt(range[s]).slice(0,10)+' '+parts.join(':'));time();};
   }
  }
 }footer();};
}
