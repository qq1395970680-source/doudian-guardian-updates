import {GuardError,requireThat,id,fingerprint,saleFen,validateHistorical,proveDraft,proveOriginalRisk} from './policy.mjs';
import {accountSlice,listSlice,detailSlice,pagerSlice,formSlice} from './platform-snapshot.mjs';
import {until,delay,parseDate,collectForm,bindFormProducts} from './collector.mjs';
import {makeWorkbook} from './workbook.mjs';
import {catalogObservation} from './catalog.mjs';
import {currentListingKey} from './priority-watch.mjs';
import {inspectRecycledProduct} from './product-state.mjs';

export const PLATFORM='https://fxg.jinritemai.com';
export const LIST='/ffa/marketing/tools/limitsales';
const active=c=>['进行中','未开始'].includes(c.status);
const button=(root,name)=>root.getByRole('button',{name:new RegExp('^'+[...name].join('\\s*')+'$')});

export class DoudianPlatform {
 constructor({browser,policy,journal,base=PLATFORM}){
  requireThat(base===PLATFORM||browser.test&&/^http:\/\/127\.0\.0\.1:\d+$/.test(base),'HOST_SCOPE','平台地址不受支持');
  this.browser=browser;this.policy=policy;this.journal=journal;this.base=base;this.inventory=null;this.progress={stage:'尚未连接'};
  this.cache=new Map();this.drafts=new Map();this.monitorPages=new Map();this.peekPending=null;this.stopping=false;
 }
 check(){requireThat(!this.stopping,'STOPPED','后台已停止');}
 async ensure(){this.check();if(!this.browser.context)await this.browser.open(this.policy.shopId,{profileKey:this.policy.profileKey});requireThat(!this.browser.loginMode,'LOGIN_OPEN','专用登录窗口尚未结束');}
 async identify(page){
  await until(async()=>{this.check();const a=await page.evaluate(accountSlice);if(a.login)throw new GuardError('LOGIN_REQUIRED','专用浏览器需要登录');return a.names.length===1;},'店铺名称尚未加载');
  let result=await page.evaluate(accountSlice),opened=false;
  if(result.ids.length===0){
   const target=page.locator('[class*="index_shopTitle__"]:visible');requireThat(await target.count()===1,'ACCOUNT_UNKNOWN','店铺入口不唯一');
   await target.hover();opened=true;await delay(500);result=await page.evaluate(accountSlice);
   if(!result.ids.length)await target.click();
   result=await until(async()=>{this.check();const a=await page.evaluate(accountSlice);return a.ids.length&&a;},'尚未读取到店铺 ID');
  }
  requireThat(result.ids.length===1&&result.names.length===1,'ACCOUNT_UNKNOWN','登录店铺身份不唯一');id(result.ids[0]);
  if(opened){await page.keyboard.press('Escape');await page.locator('body').hover({position:{x:5,y:5}});}
  return {shopId:result.ids[0],name:result.names[0],observedAt:Date.now()};
 }
 async identity(page){const account=await this.identify(page);requireThat(account.shopId===this.policy.shopId,'SHOP_MISMATCH','专用浏览器登录店铺与当前店铺不一致');return account;}
 async open(path){await this.ensure();const page=await this.browser.page();try{await page.goto(this.base+path,{waitUntil:'domcontentloaded'});await this.identity(page);return page;}catch(e){await page.close().catch(()=>{});throw e;}}
 async fault(page,task,stage,error){
  let observation=null;
  if(['prepare','submit'].includes(stage))try{const s=await page.evaluate(formSlice);observation={warnings:s.warnings,warningDetails:s.warningDetails,dialogs:s.dialogs,busy:s.busy,counts:s.counts,title:s.title,type:s.type,rules:s.rules,mode:s.mode,priceModes:s.priceModes,byDiscount:s.byDiscount,renew:s.renew};}catch{}
  await this.browser.failure(page,task,stage,error,observation).catch(()=>{});
 }
 async captureFailure(task,draft,phase,error){
  const page=draft?.page||this.drafts.get(task.id);
  if(page&&!page.isClosed())await this.fault(page,task.id,phase==='queued'?'prepare':'submit',error);
 }
 async ready(page){await until(async()=>{this.check();return await page.locator('.ecom-mcenter-spin-spinning:visible').count()===0;},'平台持续加载');}
 async list({productId=null,title=null,status=null,monitor=false}={}){
  requireThat(status===null||['进行中','未开始'].includes(status),'QUERY_SCOPE','不支持的活动状态筛选');
  requireThat(title===null||typeof title==='string'&&title.length>0&&title.length<=120,'QUERY_SCOPE','活动名称筛选无效');
  requireThat(!monitor||status&&!productId&&!title,'QUERY_SCOPE','固定监测页仅用于当前活动状态查询');
  let page=monitor?this.monitorPages.get(status):null;
  if(page?.isClosed()){this.monitorPages.delete(status);page=null;}
  if(!page){page=await this.open(LIST);if(monitor)this.monitorPages.set(status,page);}
  try{
   if(monitor){requireThat(page.url()===this.base+LIST,'QUERY_CHANGED','固定监测页地址已变化');await this.identity(page);}
   await page.locator('input[placeholder="请输入商品ID"]').waitFor();await button(page,'重置').click();await delay(1000);await this.ready(page);
   const statusSelect=page.locator('.ecom-mcenter-select').filter({has:page.locator('.ecom-mcenter-select-selection-item').filter({hasText:/^(?:全部|进行中|未开始)$/})});
   if(productId){id(productId);await page.locator('input[placeholder="请输入商品ID"]').fill(productId);}
   if(title)await page.locator('input[placeholder="请输入活动名称"]').fill(title);
   if(status){
    requireThat(await statusSelect.count()===1,'QUERY_SCOPE','活动状态筛选不唯一');
    await statusSelect.locator('.ecom-mcenter-select-selector').click();
    const option=page.locator('.ecom-mcenter-select-dropdown:visible .ecom-mcenter-select-item-option').filter({hasText:new RegExp('^'+status+'$')});
    requireThat(await option.count()===1,'QUERY_SCOPE','活动状态选项不唯一');await option.click();
    await until(async()=>(await statusSelect.locator('.ecom-mcenter-select-selection-item').innerText()).trim()===status,'活动状态尚未选中');
   }
   if(productId||title||status){await button(page,'查询').click();await delay(1000);}
   const campaigns=[],seen=new Set();
   for(let n=1;n<=100;n++){
    this.check();await this.ready(page);
    const rows=await until(async()=>{const r=await page.evaluate(listSlice);return r.length?r:/暂无数据|暂无(?:相关)?活动|没有找到/.test(await page.locator('body').innerText())?[]:false;},'活动列表未加载');
    const pager=await page.evaluate(pagerSlice);
    requireThat(pager.activeCount<=1&&(!pager.page||pager.page===n)&&pager.nextCount<=1,'LIST_PAGING','活动列表分页不明确');
    for(const r of rows){
     requireThat(r.ids.length===1&&r.cells===9&&r.times?.length===2&&r.status&&!seen.has(r.ids[0]),'LIST_INCOMPLETE','活动行不完整或重复');
     requireThat(!status||r.status===status,'QUERY_CHANGED','活动状态筛选结果不符');
     seen.add(r.ids[0]);campaigns.push({...r,id:r.ids[0],startAt:parseDate(r.times[0]),endAt:parseDate(r.times[1])});
    }
    this.progress={stage:'读取全店活动列表',campaigns:campaigns.length,page:n,at:Date.now()};
    if(pager.disabled||!rows.length&&pager.nextCount===0){await this.identity(page);
     requireThat((await page.locator('input[placeholder="请输入商品ID"]').inputValue()).trim()===(productId||''),'QUERY_CHANGED','列表查询条件变化');
     requireThat((await page.locator('input[placeholder="请输入活动名称"]').inputValue()).trim()===(title||''),'QUERY_CHANGED','活动名称筛选变化');
     requireThat(await statusSelect.count()===1&&(await statusSelect.locator('.ecom-mcenter-select-selection-item').innerText()).trim()===(status||'全部'),'QUERY_CHANGED','活动状态筛选变化');
     return {complete:true,campaigns,observedAt:Date.now(),query:{productId,title,status}};}
    requireThat(pager.nextCount===1&&rows.length,'LIST_PAGING','未取得活动列表完整性证明');
    const before=fingerprint(rows);await page.locator('li[title="下一页"] button:visible').click();
    await until(async()=>fingerprint(await page.evaluate(listSlice))!==before,'活动列表翻页停滞');
   }
   throw new GuardError('LIST_LIMIT','活动列表超过已核验页数');
  }catch(e){await this.fault(page,'inventory','list',e);if(monitor){this.monitorPages.delete(status);await page.close().catch(()=>{});}throw e;}finally{if(!monitor)await page.close();}
 }
 async listActive(){return this.currentListings(false);}
 async peekActive(){
  if(this.peekPending)return this.peekPending;
  this.peekPending=this.currentListings(true);try{return await this.peekPending;}finally{this.peekPending=null;}
 }
 async closeMonitorPages(){
  const pages=[...this.monitorPages.values()];this.monitorPages.clear();await Promise.allSettled(pages.map(page=>page.close()));
 }
 async currentListings(monitor){
  // Both status queries use independent read pages and must finish. A partial
  // result or a status transition producing duplicates cannot prove absence.
  await this.ensure();
  const results=await Promise.allSettled(['进行中','未开始'].map(status=>this.list({status,monitor})));
  const failure=results.find(r=>r.status==='rejected');if(failure){if(monitor)await this.closeMonitorPages();throw failure.reason;}
  const lists=results.map(r=>r.value),campaigns=lists.flatMap(r=>r.campaigns);
  try{
   requireThat(lists.every(r=>r.complete===true)&&campaigns.every(active)&&new Set(campaigns.map(c=>c.id)).size===campaigns.length,'ACTIVE_UNKNOWN','当前活动筛选不完整或发生交叉变化');
   return{complete:true,campaigns,observedAt:Math.min(...lists.map(r=>r.observedAt)),scope:'current-statuses',queriedStatuses:['进行中','未开始']};
  }catch(e){if(monitor)await this.closeMonitorPages();throw e;}
 }
 invalidateInventory(listing){
  requireThat(listing?.complete===true,'ACTIVE_UNKNOWN','更新后的活动列表不完整');
  this.inventory={listing,details:new Map(),activeComplete:false,readOnlyReuseMaxAgeMs:0};
  this.journal?.putSettings('catalog-view:'+this.policy.shopId,catalogObservation(this.policy.shopId,this.inventory));
 }
 refreshCurrentEvidence(listing){
  const original=this.inventory?.listing;
  if(original?.complete!==true||listing?.complete!==true||!Number.isFinite(listing.observedAt)||listing.observedAt<=0||
   listing.observedAt<(original.currentObservedAt??original.observedAt)||currentListingKey(original)!==currentListingKey(listing))return false;
  // A matching list only renews current membership for display. Keep the
  // original list and every SKU observation time intact for execution proofs.
  original.currentObservedAt=listing.observedAt;
  this.journal?.putSettings('catalog-view:'+this.policy.shopId,catalogObservation(this.policy.shopId,this.inventory));
  return true;
 }
 async detail(campaign){
  id(campaign.id);const page=await this.open(LIST+`/view?refer=view&id=${campaign.id}&is_new_limit=1&operate_use_mode=0`);
  try{
   const products=[],seen=new Set();let declared=null,rules=null;
   for(let n=1;n<=100;n++){
    await this.ready(page);let slice=await until(async()=>{const s=await page.evaluate(detailSlice);return Number.isInteger(s.declared)&&(s.products.length||s.declared===0)&&s;},'活动详情商品未加载');
    if(declared===null)declared=slice.declared;requireThat(slice.declared===declared,'DETAIL_CHANGED','详情商品总数在读取期间变化');
    if(slice.products.some(p=>!p.expanded)){
     const expectedIds=slice.products.map(p=>p.productId),sw=page.getByRole('switch'),switchCount=await sw.count();
     const checked=switchCount===1?await sw.getAttribute('aria-checked'):null;
     const useGlobal=switchCount===1&&(checked==='true'||checked==='false'&&await sw.isEnabled());
     if(useGlobal){
      if(checked==='false')await sw.click();
      // Global expansion replaces each row's expander asynchronously. Do not
      // race it with clicks based on the pre-expansion product snapshot.
     }else for(const p of slice.products){
      const current=(await page.evaluate(detailSlice)).products.find(row=>row.productId===p.productId);
      requireThat(current,'DETAIL_CHANGED','待展开商品已变化');if(current.expanded)continue;
      const expand=page.locator(`tr[data-row-key="${p.key}"]`).locator('[aria-label="展开行"]');
      requireThat(await expand.count()===1&&await expand.isVisible(),'DETAIL_EXPANSION','规格展开入口不唯一或不可见');
      await expand.click();
     }
     slice=await until(async()=>{this.check();const s=await page.evaluate(detailSlice);return s.products.length===expectedIds.length&&s.products.every(p=>expectedIds.includes(p.productId)&&p.expanded&&p.skus.length)&&s;},'活动详情规格尚未完整展开');
    }
    requireThat(declared===slice.declared,'DETAIL_CHANGED','详情数量变化');
    if(rules)requireThat(fingerprint(rules)===fingerprint(slice.rules),'DETAIL_CHANGED','详情规则变化');rules=slice.rules;
    for(const p of slice.products){
     requireThat(p.productId&&p.key.split('_')[0]===p.productId&&!seen.has(p.productId),'DETAIL_MEMBERSHIP','详情商品编号重复或不一致');seen.add(p.productId);
     requireThat(p.skus.length&&new Set(p.skus.map(s=>s.id)).size===p.skus.length,'DETAIL_SKUS','详情规格缺失或重复');
     for(const s of p.skus){id(s.id);requireThat(s.name&&s.baseFen>0&&Number.isInteger(s.discount),'DETAIL_SKUS','详情规格字段不完整');
      if(s.saleFen===null){s.saleFen=saleFen(s.baseFen,s.discount);s.saleSource='computed-from-verified-base-and-discount';}else s.saleSource='observed';}
     products.push(p);
    }
    const pager=await page.evaluate(pagerSlice);
    requireThat(pager.nextCount<=1&&pager.activeCount<=1&&(!pager.page||pager.page===n),'DETAIL_PAGING','详情包含未处理的嵌套或未知分页');
    if(!pager.nextCount||pager.disabled){
     requireThat(seen.size===declared,'DETAIL_INCOMPLETE',`详情声明 ${declared} 件，完整读取 ${seen.size} 件`);
     await this.identity(page);return {complete:true,products,rules,observedAt:Date.now()};
    }
    const before=slice.products.map(p=>p.productId).join(',');await page.locator('li[title="下一页"] button:visible').click();
    await until(async()=>(await page.evaluate(detailSlice)).products.map(p=>p.productId).join(',')!==before,'详情翻页停滞');
   }
   throw new GuardError('DETAIL_LIMIT','活动详情超过页数上限');
  }catch(e){await this.fault(page,campaign.id,'detail',e);throw e;}finally{await page.close();}
 }
 async discover({readOnlyReuseMaxAgeMs=0,historyReadLimit=20,onReadBoundary=null,onReadBatchStart=null}={}){
  requireThat(Number.isInteger(historyReadLimit)&&historyReadLimit>=0&&historyReadLimit<=20,'HISTORY_BUDGET','历史读取预算无效');
  requireThat(Number.isSafeInteger(readOnlyReuseMaxAgeMs)&&readOnlyReuseMaxAgeMs>=0&&readOnlyReuseMaxAgeMs<=900000,'READ_CACHE_SCOPE','只读证据复用时间无效');
  const listing=historyReadLimit===0?await this.listActive():await this.list(),details=new Map(),baselines=[],errors=[];
  const campaigns=[...listing.campaigns].sort((a,b)=>Number(active(b))-Number(active(a))||b.startAt-a.startAt);
  let historyReads=0,activeRead=0;
  const activeJobs=[],historyJobs=[],activeTotal=campaigns.filter(active).length;
  for(const c of campaigns){
   this.check();
   const key=fingerprint(c);let detail=this.cache.get(key);
   if(!detail){const saved=this.journal?.settings('campaign:'+c.id);if(saved?.key===key)detail=saved.detail;}
   const attempt=this.journal?.settings('campaign-attempt:'+c.id);
   const detailAge=Date.now()-(detail?.observedAt||0);
   const readActive=active(c)&&!(readOnlyReuseMaxAgeMs>0&&detail?.complete===true&&detailAge>=0&&detailAge<=readOnlyReuseMaxAgeMs);
   if(readActive||!detail&&historyReads<historyReadLimit&&!(attempt?.key===key&&attempt.retryAt>Date.now())){
    if(!active(c))historyReads++;
    (active(c)?activeJobs:historyJobs).push({c,key});
   }else if(detail){details.set(c.id,detail);if(active(c))activeRead++;}
  }
  let priorityRefreshRequired=false,priorityListing=null;
  const publish=()=>{
   this.inventory={listing,details,activeComplete:campaigns.filter(active).every(c=>details.has(c.id)),readOnlyReuseMaxAgeMs};
   this.journal?.putSettings('catalog-view:'+this.policy.shopId,catalogObservation(this.policy.shopId,this.inventory));
  };
  // Publish completed reads as they arrive. This display snapshot does not
  // authorize a loss while any active activity remains unread.
  publish();
  const boundary=async(reads,moreReads=false)=>{
   if(!onReadBoundary)return;
   this.check();const result=await onReadBoundary({listing,reads,deferListPoll:!!onReadBatchStart&&moreReads});this.check();
   if(result?.refreshRequired){
    requireThat(result.listing?.complete===true,'ACTIVE_UNKNOWN','优先核对后的活动列表不完整');
    priorityRefreshRequired=true;priorityListing=result.listing;
   }
  };
  await boundary([],activeJobs.length+historyJobs.length>0);
  const readGroup=async(jobs,stage,remainingJobs=0)=>{
   const inFlight=new Set();
   const progress=()=>{this.progress={stage,read:details.size,total:campaigns.length,activeRead,activeTotal,inFlight:[...inFlight],at:Date.now()};};
   const worker=async({c,key})=>{
     this.check();inFlight.add(c.id);progress();
     try{
      const detail=await this.detail(c);requireThat(detail?.complete===true,'DETAIL_INCOMPLETE','活动详情未完整读取');
      this.cache.set(key,detail);this.journal?.putSettings('campaign:'+c.id,{key,detail});details.set(c.id,detail);publish();
      return {campaign:c,detail};
     }catch(e){
      if(e.code==='STOPPED')throw e;
      const error={campaignId:c.id,code:e.code||'READ_ERROR',message:e.message};errors.push(error);
      this.journal?.putSettings('campaign-attempt:'+c.id,{key,retryAt:Date.now()+15*60000,error});
     }finally{inFlight.delete(c.id);if(active(c))activeRead++;progress();}
   };
   // Priority checks may create a recovery. Close both independent detail pages
   // before entering that boundary or launching the next pair of readers.
   for(let cursor=0;cursor<jobs.length&&!priorityRefreshRequired;cursor+=2){
    this.check();if(onReadBatchStart)await onReadBatchStart();
    const results=await Promise.allSettled(jobs.slice(cursor,cursor+2).map(worker));
    const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
    this.check();await boundary(results.map(r=>r.value).filter(Boolean),cursor+2<jobs.length||remainingJobs>0);
   }
  };
  await readGroup(activeJobs,'核对当前活动',historyJobs.length);
  await readGroup(historyJobs,'补读完整历史');
  // Network completion order must not change historical selection or batching.
  for(const c of campaigns){
   const detail=details.get(c.id);if(!detail)continue;
   for(const p of detail.products){
    if(this.policy.captureExistingOnly&&(!active(c)||p.removalConfirmed||p.removalAmbiguous))continue;
    const baseline={source:'verified-platform-history',complete:true,shopId:this.policy.shopId,productId:p.productId,name:p.name,campaignId:c.id,
     historyAt:c.startAt,generatedByGuardian:c.name.startsWith('守护2-'),observedAt:detail.observedAt,type:c.type,rules:detail.rules,skus:p.skus};
    try{validateHistorical(baseline);baselines.push(baseline);}catch(e){errors.push({campaignId:c.id,productId:p.productId,code:e.code,message:e.message});}
   }
  }
  const activeComplete=!priorityRefreshRequired&&campaigns.filter(active).every(c=>details.has(c.id));
  if(priorityRefreshRequired){
   // A changed inventory is a new observation, never a complete copy of the old
   // one. The next scan will populate its freshly verified positive details.
   this.invalidateInventory(priorityListing);
  }else publish();
  this.progress={stage:priorityRefreshRequired?'优先核对已完成，继续同步当前活动':activeComplete?'全店当前活动核对完成':'当前活动仍有读取失败，暂停恢复',campaigns:campaigns.length,details:details.size,
   historiesPending:campaigns.filter(c=>!details.has(c.id)).length,errors,at:Date.now()};
  return {baselines,complete:!priorityRefreshRequired&&details.size===campaigns.length,activeComplete,priorityRefreshRequired,errors};
 }
 async loss(baseline,{fresh=false}={}){
  if(fresh){
   const listing=await this.list({productId:baseline.productId}),details=new Map();
   for(const c of listing.campaigns.filter(active))details.set(c.id,await this.detail(c));
   return this.lossFrom(baseline,listing,details,true,true);
  }
  requireThat(this.inventory?.activeComplete,'ACTIVE_UNKNOWN','全店有效活动尚未完整核对');
  return this.lossFrom(baseline,this.inventory.listing,this.inventory.details,true);
 }
 lossFrom(baseline,listing,details,complete,productScoped=false){
  const related=[];
  for(const c of listing.campaigns.filter(active)){
   const d=details.get(c.id);requireThat(d?.complete,'ACTIVE_UNKNOWN','有效活动规格未完整读取');
   const p=d.products.find(p=>p.productId===baseline.productId);
   if(p&&!p.removalConfirmed)return {complete,active:true,ambiguous:p.removalAmbiguous===true,campaignId:c.id,observedAt:Date.now()};
   if(p)related.push(c.id+':removed');
  }
  const previous=listing.campaigns.find(c=>c.id===baseline.campaignId);
  // Routine full/current-only listings describe the same missing product even
  // when ended history is omitted or rows reorder. Keep its retry budget stable.
  // Fresh product-scoped evidence retains campaign history to distinguish a
  // later platform removal from a previously verified restoration.
  return {complete,active:false,observedAt:Date.now(),lossKey:fingerprint({productId:baseline.productId,history:baseline.campaignId,related:related.sort(),
   ...(productScoped?{status:previous?.status||'absent',campaigns:listing.campaigns.map(c=>[c.id,c.status,c.startAt,c.endAt,c.risk]).sort((a,b)=>a[0].localeCompare(b[0]))}: {})})};
 }
 async selectProduct(page,productId){
  await button(page,'添加商品').click();const picker=page.locator('.ecom-mcenter-drawer-open[class*="index-goodsDrawer--"]:visible');await picker.waitFor();
  const seen=new Set();
  for(let n=1;n<=100;n++){
   this.check();await this.ready(page);
   const rows=picker.locator('tr').filter({hasText:/商品ID[：:]\s*\d+/});
   await rows.first().waitFor();
   const texts=await rows.allInnerTexts();
   for(let i=0;i<texts.length;i++){
    const found=texts[i].match(/商品ID[：:]\s*(\d+)/)?.[1];requireThat(found&&!seen.has(found),'PICKER_PAGING','选品分页重复');seen.add(found);
    if(found!==productId)continue;
    requireThat(!/(?:商品状态[：:]\s*)?已下架/.test(texts[i]),'OFF_SHELF','商品已明确下架');
    requireThat(!/当前已参与单品直降/.test(texts[i]),'ALREADY_ACTIVE','商品已有有效活动');
    const box=rows.nth(i).getByRole('checkbox');requireThat(await box.count()===1&&await box.isEnabled(),'PICKER_DISABLED','商品当前不能唯一选择');
    await box.check();await button(picker,'确定').click();await picker.waitFor({state:'hidden'});return;
   }
   const next=picker.locator('li[title="下一页"] button:visible');requireThat(await next.count()===1,'PICKER_PAGING','选品分页不明确');
   if(await next.isDisabled())throw new GuardError('NOT_FOUND','完整选品列表未找到商品，不能据此认定下架');
   await next.click();const signature=texts.join('|');await until(async()=>(await rows.allInnerTexts()).join('|')!==signature,'选品翻页停滞');
  }
  throw new GuardError('PICKER_LIMIT','选品分页超过上限');
 }
 async expand(page){
  await until(async()=>{
   this.check();const s=await page.evaluate(formSlice);
   return !s.busy&&s.counts.length&&s.counts.every(n=>n>0)&&s.cells.some(c=>c.rows.some(r=>r.kind==='product'));
  },'选品后商品及规格表仍在加载',60000);
  const sw=page.getByRole('switch');requireThat(await sw.count()===1,'EXPANSION_UNKNOWN','规格展开开关不唯一');
  if(await sw.getAttribute('aria-checked')==='false')await sw.click();
 }
 async precheck(baseline){
  this.progress={stage:'读取当前完整规格',productId:baseline.productId,at:Date.now()};
  const prior=this.journal?.productChecks?.(this.policy.shopId).find(c=>c.shopId===this.policy.shopId&&c.productId===baseline.productId&&['PRODUCT_RECYCLED','NOT_FOUND'].includes(c.code));
  let recycleChecked=false;
  const checkRecycle=async()=>{
   recycleChecked=true;const proof=await inspectRecycledProduct(this,baseline.productId);
   if(proof)throw new GuardError('PRODUCT_RECYCLED','商品已在平台回收站，跳过折扣恢复并保留完整历史',{productState:proof});
  };
  if(prior)await checkRecycle();
  const page=await this.open(LIST+'/create');
  try{
   await page.locator('#title').waitFor();const initial=await page.evaluate(formSlice);
   requireThat(!initial.counts.some(n=>n>0)&&!initial.cells.some(c=>c.rows.length),'DRAFT_NOT_EMPTY','新的预查页已有商品');
   await this.selectProduct(page,baseline.productId);await this.expand(page);
   const {products,snapshot}=await collectForm(page,{precheck:true});
   requireThat(products.length===1&&products[0].productId===baseline.productId&&snapshot.counts.length&&snapshot.counts.every(n=>n===1),'PRECHECK_MEMBERSHIP','预查商品集合不一致');
   await this.identity(page);return {shopId:this.policy.shopId,productId:baseline.productId,complete:true,observedAt:Date.now(),offShelf:products[0].offShelf,skus:products[0].skus};
  }catch(e){
   if(e.code==='NOT_FOUND'&&!recycleChecked){await page.close();await checkRecycle();}
   await this.fault(page,baseline.productId,'precheck',e);throw e;
  }finally{if(!page.isClosed())await page.close();}
 }
 async radio(page,label){
  const control=page.locator('label').filter({hasText:new RegExp('^'+label+'$')}).filter({has:page.locator('input[type="radio"]')});
  requireThat(await control.count()===1,'RULE_CONTROL',`无法唯一读取 ${label}`);
  if(!await control.locator('input').isChecked())await control.click();
  await until(()=>control.locator('input').isChecked(),`${label} 未生效`);
 }
 async rules(page,plan){
  await this.radio(page,'不设置');await this.radio(page,'不限购');
  const more=button(page,'更多配置（订单取消时间、是否预热）');
  if(await more.count()===1&&await more.getAttribute('aria-expanded')==='false')await more.click();
  await this.radio(page,'不预热');
  const select=page.locator('.ecom-mcenter-select').filter({has:page.locator('#order_expire_time')});
  await select.locator('.ecom-mcenter-select-selection-item').waitFor();
  if((await select.locator('.ecom-mcenter-select-selection-item').innerText()).trim()!==plan.rules.orderMinutes+'分钟'){
   await select.locator('.ecom-mcenter-select-selector').click();
   await page.locator('.ecom-mcenter-select-dropdown:visible .ecom-mcenter-select-item-option').filter({hasText:new RegExp('^'+plan.rules.orderMinutes+'分钟$')}).click();
  }
  const renew=page.locator('#renew_switch_on');if(await renew.count())await this.radio(page,'不开启');
 }
 async observeDraft(task,page,{originalRisk=false,priceReview=false}={}){
  const {products,snapshot}=await collectForm(page,{originalRisk});
  requireThat(snapshot.counts.length&&snapshot.counts.every(n=>n===task.plans.length)&&snapshot.mode==='Excel批量导入'&&snapshot.byDiscount&&!snapshot.renew,'DRAFT_RULES',
   '导入数量、打折方式或续期规则未核对：'+JSON.stringify({expectedCount:task.plans.length,counts:snapshot.counts,mode:snapshot.mode,priceModes:snapshot.priceModes,byDiscount:snapshot.byDiscount,renew:snapshot.renew}));
  requireThat(products.every(p=>!p.errors.length&&(priceReview||p.skus.every(s=>!s.errors.length))),'DRAFT_WARNING','商品或规格有未解决的价格提示');
  const dates=snapshot.dates.map(parseDate);requireThat(dates.length===2,'DRAFT_TIME','草稿时间不完整');
  return {kind:'draft',shopId:this.policy.shopId,title:snapshot.title,type:snapshot.type,rules:snapshot.rules,startAt:dates[0],endAt:dates[1],
   complete:true,observedAt:Date.now(),rows:bindFormProducts(products,task.plans),warnings:snapshot.warnings,dialogs:snapshot.dialogs};
 }
 async prepare(task){
  requireThat(this.policy.liveEnabled&&this.policy.cutoverConfirmed,'CUTOVER_REQUIRED','尚未切换执行权');
  this.progress={stage:'准备独立的干净创建页',taskId:task.id,at:Date.now()};const page=await this.open(LIST+'/create');
  this.drafts.set(task.id,page);
  try{
   await page.locator('#title').waitFor();const initial=await page.evaluate(formSlice);
   requireThat(!initial.counts.some(n=>n>0)&&!initial.cells.some(c=>c.rows.length)&&!initial.dialogs.length,'DRAFT_NOT_EMPTY','新创建页不为空');
   const card=page.locator('.market-activity-radio-card-item').filter({has:page.locator('[class*="index-title--"]').filter({hasText:new RegExp('^'+task.plans[0].type+'$')})});
   requireThat(await card.count()===1,'TYPE_UNKNOWN','活动类型不唯一');if(!(await card.getAttribute('class')).split(' ').includes('active'))await card.click();
   // This page has never selected products online. No clear/switch recovery.
   await this.radio(page,'Excel批量导入');await this.rules(page,task.plans[0]);await page.locator('#title').fill(task.title);
   await page.locator('input[placeholder="开始日期"]').click();await button(page,'近48小时').click();
   await this.identity(page);this.check();this.assertWrite();
   this.journal.assertPricePlans(task.shopId,task.plans);
   const file=page.locator('input[type="file"][accept*=".xlsx"]');requireThat(await file.count()===1,'UPLOAD_CONTROL','官方导入控件不唯一');
   await file.setInputFiles({name:task.title+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:makeWorkbook(task.plans)});
   const expected=`全部${task.plans.length}个商品（共${task.plans.reduce((n,p)=>n+p.skus.length,0)}个规格）上传成功`;
   await until(async()=>{this.check();const t=(await page.locator('body').innerText()).replace(/\s/g,'');
    if(/全部商品或规格上传失败|查看上传失败信息/.test(t))throw new GuardError('IMPORT_REJECTED','平台拒绝部分原折扣；未调整价格或提交');return t.includes(expected);},'导入未返回完整成功数量',60000);
   await this.rules(page,task.plans[0]);await this.expand(page);await this.identity(page);
   const observation=await this.observeDraft(task,page,{priceReview:true});
   if(observation.rows.some(row=>row.errors?.length))throw new GuardError('PRICE_REVIEW_REQUIRED','平台要求调整价格，等待逐规格建议和本人确认；未填入更低价格',
    {priceProbe:{...observation,source:'live-platform-draft'}});
   proveDraft(task,observation);
   return {page,observation};
  }catch(e){await this.fault(page,task.id,'prepare',e);throw e;}
 }
 async submit(task,draft,beforeRisk,beforeSubmit){
  const page=draft.page;this.check();await this.identity(page);
  // Reacquire and compare the complete draft immediately before native click.
  const latest=await this.observeDraft(task,page),proof=proveDraft(task,latest);
  requireThat(proof.materialFingerprint===proveDraft(task,draft.observation).materialFingerprint,'DRAFT_CHANGED','持久提交记录后的草稿已变化');
  const submitControl=page.getByRole('button',{name:/^(?:创\s*建|提\s*交)$/}).filter({visible:true});
  requireThat(await submitControl.count()===1,'SUBMIT_CONTROL','主表单提交按钮不唯一');
  await submitControl.click({trial:true});
  this.check();this.assertWrite();await beforeSubmit(proof);await submitControl.click();
  const state=await until(async()=>{
   const dialogs=page.getByRole('dialog').filter({has:button(page,'仍要创建')});
   if(await dialogs.count())return 'risk';
   if(new URL(page.url()).pathname===LIST||/创建成功/.test(await page.locator('body').innerText()))return 'sent';
   const alerts=await page.locator('[role="alert"]:visible').allInnerTexts();if(alerts.some(t=>/失败|错误|不得|不能/.test(t)))throw new GuardError('SUBMIT_RESULT_UNKNOWN',alerts.join('；'));
   return false;
  },'提交后平台结果尚未确定',45000);
  if(state==='risk'){
   await this.confirmOriginalRisk(this.journal.get(task.id),page,beforeRisk);
  }
 }
 async confirmOriginalRisk(task,page,beforeRisk){
  this.check();const url=new URL(page.url());
  requireThat(url.origin===this.base&&url.pathname===LIST+'/create','RISK_CHANGED','原确认页地址变化');
  // The modal deliberately covers the header. Verify this same dedicated
  // context on a separate read page, without hovering through the risk overlay.
  const account=await this.probe(),shown=await page.evaluate(accountSlice);
  requireThat(!shown.login&&shown.names.length===1&&shown.names[0]===account.name&&shown.ids.every(value=>value===account.shopId),
    'SHOP_MISMATCH','原确认页与当前专用浏览器店铺不一致');
  const observation=await this.observeDraft(task,page,{originalRisk:true});proveOriginalRisk(task,observation);
  const dialogs=page.getByRole('dialog').filter({visible:true});requireThat(await dialogs.count()===1,'RISK_CHANGED','低价提示已变化');
  const selected=await dialogs.locator('input[type="radio"]:checked').evaluateAll(nodes=>nodes.map(n=>n.closest('label')?.innerText||''));
  requireThat(!selected.length||selected.length===1&&/^全部商品\s*\d+$/.test(selected[0].trim()),'RISK_CHANGED','低价提示尚未显示全部风险商品');
  const control=button(dialogs,'仍要创建');requireThat(await control.count()===1,'RISK_CHANGED','原折扣确认控件不唯一');
  await control.click({trial:true});this.check();this.assertWrite();
  await beforeRisk({taskId:task.id,kind:'original-discount-risk',at:Date.now(),observation});
  this.check();this.assertWrite();await control.click();
  await until(async()=>new URL(page.url()).pathname===LIST||/创建成功/.test(await page.locator('body').innerText()),'原折扣确认后结果待核实',45000);
 }
 async resumeOriginalRisk(task,beforeRisk){
  const page=this.drafts.get(task.id);
  if(!page||page.isClosed()||task.submitAttempts!==1||task.riskAttempts!==0)return false;
  if(await page.getByRole('dialog').filter({has:button(page,'仍要创建')}).count()!==1)return false;
  // Only the original in-memory page can be continued. No page is reconstructed
  // from diagnostics and no main-submit click is repeated after an unknown result.
  await this.confirmOriginalRisk(task,page,beforeRisk);return true;
 }
 async readback(task){
  this.progress={stage:'独立页面逐规格回读',taskId:task.id,at:Date.now()};
  const listing=await this.list({title:task.title}),matches=listing.campaigns.filter(c=>c.name===task.title);
  requireThat(matches.length<=1,'DUPLICATE_CAMPAIGN','同任务出现多个活动，保留记录并停止自动处理');if(!matches.length)return null;
  const campaign=matches[0];if(!active(campaign))return null;const d=await this.detail(campaign);
  requireThat(d.products.every(p=>!p.removalConfirmed&&!p.removalAmbiguous),'READBACK_REMOVED','新活动已有商品或规格退出，不能记为恢复成功');
  return {complete:d.complete,shopId:this.policy.shopId,title:campaign.name,campaignId:campaign.id,status:campaign.status,
   observedAt:d.observedAt,type:campaign.type,rules:d.rules,rows:d.products.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),startAt:campaign.startAt,endAt:campaign.endAt};
 }
 async release(task){if(['unknown','submitting','verifying'].includes(task.phase))return;const page=this.drafts.get(task.id);this.drafts.delete(task.id);if(page)await page.close();}
 async probe(){const page=await this.open(LIST);try{return await this.identity(page);}finally{await page.close();}}
}
