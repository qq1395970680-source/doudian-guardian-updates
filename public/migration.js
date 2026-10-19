export function createMigration({getState,post,toast,node,money,discount,time}){
 const $=id=>document.getElementById(id);let preview=null,busy=false,shop=null,productPage=0,skuPages=new Map();
 const selected=()=>getState().state?.shopId;
 const connected=()=>{const s=getState();return s.online&&s.state?.connection?.shopId===selected()&&selected();};
 const idle=()=>{const s=getState().state;return s&&!s.running&&!s.busy&&!s.action;};
 function sync(){
  if(shop!==selected()){shop=selected();preview=null;skuPages.clear();$('transfer-preview').hidden=true;$('transfer-consent').checked=false;}
  $('export-transfer').disabled=busy||!connected();$('choose-transfer').disabled=busy||!connected();
  $('import-transfer').disabled=busy||!preview||preview.shopId!==selected()||!connected()||!idle()||preview.expiresAt<=Date.now()||!$('transfer-consent').checked;
  $('transfer-consent').disabled=busy||!preview||!connected()||preview.expiresAt<=Date.now();
  if(preview)$('transfer-state').textContent=preview.expiresAt<=Date.now()?'预览已过期，请重新选择备份。':!idle()?'请先暂停守护，再确认导入。':'确认只导入已展示的历史；新的降价要求仍需另行确认。';
 }
 function renderProducts(){
  const all=preview.products,pages=Math.max(1,Math.ceil(all.length/10));productPage=Math.min(productPage,pages-1);const fragment=document.createDocumentFragment();
  for(const p of all.slice(productPage*10,(productPage+1)*10)){
   const detail=node('details','transfer-product'),summary=node('summary');summary.append(node('strong','',p.name||p.productId),node('small','',`${p.productId} · ${p.skus.length} 个规格`));detail.append(summary);let loaded=false;
   detail.addEventListener('toggle',()=>{if(!detail.open||loaded)return;loaded=true;
    const table=node('table','sku-table'),head=node('thead'),tr=node('tr'),body=node('tbody');for(const h of ['规格','原价','历史折后价','折扣'])tr.append(node('th','',h));head.append(tr);table.append(head,body);
    const pager=node('div','pagination'),label=node('span'),buttons=node('div'),prev=node('button','button small secondary','上一页规格'),next=node('button','button small secondary','下一页规格');buttons.append(prev,next);pager.append(label,buttons);
    const draw=()=>{const index=skuPages.get(p.productId)||0,max=Math.max(1,Math.ceil(p.skus.length/25)),rows=document.createDocumentFragment();for(const s of p.skus.slice(index*25,(index+1)*25)){const row=node('tr');for(const value of [s.name,money(s.baseFen),money(s.saleFen),discount(s.discount)])row.append(node('td','',value));rows.append(row);}body.replaceChildren(rows);label.textContent=`全部 ${p.skus.length} 个规格 · 第 ${index+1} / ${max} 页`;prev.disabled=index===0;next.disabled=index===max-1;};
    prev.onclick=()=>{skuPages.set(p.productId,(skuPages.get(p.productId)||0)-1);draw();};next.onclick=()=>{skuPages.set(p.productId,(skuPages.get(p.productId)||0)+1);draw();};draw();detail.append(table,pager);
   });fragment.append(detail);
  }
  if(!all.length)fragment.append(node('div','empty','备份中没有折扣历史'));$('transfer-products').replaceChildren(fragment);
  $('transfer-page').textContent=`${all.length} 件商品 · 第 ${productPage+1} / ${pages} 页`;$('transfer-prev').disabled=productPage===0;$('transfer-next').disabled=productPage===pages-1;
 }
 $('transfer-prev').onclick=()=>{productPage--;renderProducts();};$('transfer-next').onclick=()=>{productPage++;renderProducts();};$('transfer-consent').onchange=sync;
 $('export-transfer').onclick=async()=>{
  if(busy||!connected())return;if(!window.guardianDesktop?.saveTransfer){toast('请从桌面“抖店折扣守护”打开程序，保存迁移备份。');return;}
  const expected=selected();busy=true;sync();
  try{
   $('transfer-status').textContent='正在暂停守护，等待当前动作安全结束…';await post('stop');
   const until=Date.now()+120000;let done=false;
   while(Date.now()<until){const r=await fetch('/api/status',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('后台连接暂时不可用');const s=await r.json();if(s.shopId!==expected)throw Error('店铺已变化，迁移已停止');if(!s.running&&!s.busy&&!s.action){done=true;break;}await new Promise(r=>setTimeout(r,1000));}
   if(!done)throw Error('当前动作仍在安全收尾，守护已请求暂停。稍后可再次保存备份。');
   const result=await post('migration/export',{shopId:expected}),saved=await window.guardianDesktop.saveTransfer(result.file);
   $('transfer-status').textContent=saved.canceled?'未保存备份，守护已暂停。需要继续本机守护时可回到概览开启。':'迁移备份已保存，守护已暂停。请在新电脑登录同一家店，再导入此备份。';
   toast(saved.canceled?'未保存迁移备份':'迁移备份已保存');
  }catch(e){$('transfer-status').textContent=e.message;toast(e.message);}finally{busy=false;sync();}
 };
 $('choose-transfer').onclick=async()=>{
  if(busy||!connected())return;if(!window.guardianDesktop?.chooseTransfer){toast('请从桌面程序选择迁移备份。');return;}
  const expected=selected();busy=true;sync();try{
   const result=await window.guardianDesktop.chooseTransfer();if(result.canceled)return;
   if(expected!==selected())throw Error('店铺已变化，请重新选择备份');
   const next=await post('migration/preview',{shopId:expected,file:result.file});if(expected!==selected())return;
   preview=next;productPage=0;skuPages.clear();$('transfer-consent').checked=false;$('transfer-preview').hidden=false;
   $('transfer-summary').textContent=`${preview.name} · ${preview.shopId} · 备份时间 ${time(preview.createdAt)} · ${preview.historicalCount} 份完整历史 · ${preview.taskCount} 项任务记录`;
   $('transfer-warning').textContent=`排除商品：${preview.excludedProductIds.length?preview.excludedProductIds.join('、'):'无'}。${preview.unknown} 项提交结果待核实，将保留为只回读任务。已有排除项继续保留。`;
   renderProducts();
  }catch(e){preview=null;$('transfer-preview').hidden=true;toast(e.message);}finally{busy=false;sync();}
 };
 $('import-transfer').onclick=async()=>{
  sync();if($('import-transfer').disabled)return;const chosen=preview;busy=true;sync();try{
   const result=await post('migration/import',{shopId:chosen.shopId,previewId:chosen.previewId,digest:chosen.digest,accepted:true});
   preview=null;$('transfer-preview').hidden=true;$('transfer-consent').checked=false;
   $('transfer-status').textContent=`已合并 ${result.importedHistories} 份历史，保留 ${result.unknown} 项待核实提交。可在折扣概览开启守护；恢复前仍会核对平台当前活动和每个规格。`;toast('迁移历史已导入');
  }catch(e){toast(e.message);}finally{busy=false;sync();}
 };
 return{sync};
}
