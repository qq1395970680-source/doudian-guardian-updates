// Test-only picker: calendar selection changes only the date, and each time
// column changes only its own component. Nothing injects the requested end time.
export function installDateTimeFixture({start,duration,mode='',onCommit=null}){
 const fmt=t=>new Date(t+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');
 const fields=[...document.querySelectorAll('input[placeholder$="日期"]')];
 fields.forEach(f=>f.readOnly=true);fields[0].value=fmt(start);fields[1].value=fmt(start+86400000);
 const picker=document.createElement('div');picker.className='ecom-mcenter-picker-dropdown';picker.hidden=true;
 const targetDate=fmt(start+duration).slice(0,10).replaceAll('/','-');
 picker.innerHTML=`<a id="anchor">近1天</a><table><tr><td class="ecom-picker-cell-in-view" title="${targetDate}">${targetDate}</td></tr></table><a id="time">选择时间</a><div class="ecom-picker-time-panel" hidden></div><button>确定</button>`;
 document.body.append(picker);let draft=start+86400000,side=1;
 window.timeClicks=[];window.dateCommits=0;window.fieldInputEvents=0;
 fields.forEach((f,i)=>{f.onclick=()=>{side=i;picker.hidden=false;};f.oninput=()=>window.fieldInputEvents++;});
 if(mode==='shortcut48')picker.querySelector('#anchor').textContent='近48小时';
 picker.querySelector('#anchor').onclick=()=>{draft=start+(mode==='shortcut48'?2:1)*86400000;side=1;};
 picker.querySelector('td').onclick=()=>{draft=Date.parse(targetDate+'T'+fmt(draft).slice(11)+'+08:00');};
 const panel=picker.querySelector('.ecom-picker-time-panel');
 const render=()=>{panel.innerHTML='';const parts=fmt(draft).slice(11).split(':').map(Number);
  for(let col=0;col<(mode==='missing-column'?2:3);col++){
   const ul=document.createElement('ul');ul.className='ecom-picker-time-panel-column';panel.append(ul);
   for(let value=0;value<(col===0?24:60);value++){
    const cell=document.createElement('li');cell.className='ecom-picker-time-panel-cell'+(parts[col]===value?' ecom-picker-time-panel-cell-selected':'')+(mode==='disabled-time'?' ecom-picker-time-panel-cell-disabled':'');cell.textContent=String(value).padStart(2,'0');ul.append(cell);
    cell.onclick=()=>{window.timeClicks.push({side,col,value});if(mode==='ignored-time')return;const next=fmt(draft).slice(11).split(':');next[col]=cell.textContent;draft=Date.parse(fmt(draft).slice(0,10).replaceAll('/','-')+'T'+next.join(':')+'+08:00');render();};
   }
  }
 };
 picker.querySelector('#time').onclick=()=>{panel.hidden=false;render();if(mode==='ambiguous-time')picker.append(panel.cloneNode(true));};
 picker.querySelector('button').onclick=()=>{fields[0].value=fmt(start+(mode==='changed-start'&&window.dateCommits?1000:0));fields[1].value=fmt(draft+(mode==='wrong-final'&&window.dateCommits?1000:0));window.dateCommits++;picker.hidden=true;panel.hidden=true;if(onCommit)window[onCommit](fields[0].value,fields[1].value);};
}
