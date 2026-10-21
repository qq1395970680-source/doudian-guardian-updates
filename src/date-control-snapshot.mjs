// Read-only DOM evidence for date-control failures. No cookies, storage,
// network headers, source scripts, hidden input values or URL query strings.
// The snapshot is diagnostic only and must never authorize recovery.
export function dateControlSnapshot(){
 const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
 const text=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,90);
 const describe=el=>({tag:el.tagName.toLowerCase(),id:el.id||null,className:typeof el.className==='string'?el.className:null,
  role:el.getAttribute('role'),title:el.getAttribute('title'),ariaLabel:el.getAttribute('aria-label'),
  ariaControls:el.getAttribute('aria-controls'),ariaExpanded:el.getAttribute('aria-expanded'),
  ariaSelected:el.getAttribute('aria-selected'),ariaDisabled:el.getAttribute('aria-disabled'),
  disabled:el.disabled===true,visible:visible(el),text:text(el)});
 const fields=[...document.querySelectorAll('input[placeholder="开始日期"],input[placeholder="结束日期"]')].filter(visible);
 const inputs=fields.map(el=>{const ancestors=[];for(let p=el.parentElement;p&&p!==document.body&&ancestors.length<5;p=p.parentElement)ancestors.push(describe(p));
  return{...describe(el),placeholder:el.getAttribute('placeholder'),value:el.value,readonly:el.readOnly,ancestors};});
 const related=[...document.querySelectorAll('[class],[role="dialog"]')].filter(el=>
  /(?:calendar|picker|popover|popup)/i.test(String(el.className))&&visible(el));
 const roots=related.filter(el=>!related.some(parent=>parent!==el&&parent.contains(el))).slice(0,12);
 const panels=roots.map(root=>{
  const all=[root,...root.querySelectorAll('*')].filter(visible);
  const controls=all.filter(el=>['BUTTON','A','TD','TH','LI','UL','INPUT'].includes(el.tagName)||
   /(?:header|time|month|year|panel|calendar|picker|selected|disabled)/i.test(String(el.className)));
  return{...describe(root),nodeCount:controls.length,truncated:controls.length>700,
   controls:controls.slice(0,700).map(el=>({...describe(el),parentClass:typeof el.parentElement?.className==='string'?el.parentElement.className:null}))};
 });
 return{schema:1,at:Date.now(),diagnosticOnly:true,inputs,panels,
  legacyDropdownMatches:[...document.querySelectorAll('[class*="picker-dropdown"]')].map(describe),
  focused:document.activeElement&&fields.includes(document.activeElement)?document.activeElement.getAttribute('placeholder'):null};
}
