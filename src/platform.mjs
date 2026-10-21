import {GuardError,requireThat,id,fingerprint,saleFen,validateHistorical,proveDraft,proveOriginalRisk,proveReadback,isLimited} from './policy.mjs';
import {accountSlice,listSlice,detailSlice,pagerSlice,formSlice,scrollForm} from './platform-snapshot.mjs';
import {until,delay,parseDate,collectForm,bindFormProducts} from './collector.mjs';
import {makeWorkbook} from './workbook.mjs';
import {catalogObservation} from './catalog.mjs';
import {PriorityWatch,currentListingKey} from './priority-watch.mjs';
import {inspectRecycledProduct} from './product-state.mjs';
import {readRemovalWorkbook} from './removal-export.mjs';
import {createHash} from 'node:crypto';
import {draftPriceWarnings} from './draft-price-warnings.mjs';
import {chooseReadonlyDateRange} from './date-picker.mjs';

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
  if(error.code==='DRAFT_PRICE'&&error.detail?.mismatches)observation={...observation,mismatches:error.detail.mismatches};
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
 publishCatalog(){
  if(!this.journal)return;
  const key='catalog-view:'+this.policy.shopId;
  this.journal.putSettings(key,catalogObservation(this.policy.shopId,this.inventory,this.journal.settings(key)));
 }
 invalidateInventory(listing){
  requireThat(listing?.complete===true,'ACTIVE_UNKNOWN','更新后的活动列表不完整');
  this.inventory={listing,details:new Map(),activeComplete:false,readOnlyReuseMaxAgeMs:0};
  this.publishCatalog();
 }
 refreshCurrentEvidence(listing){
  const original=this.inventory?.listing;
  if(original?.complete!==true||listing?.complete!==true||!Number.isFinite(listing.observedAt)||listing.observedAt<=0||
   listing.observedAt<(original.currentObservedAt??original.observedAt)||currentListingKey(original)!==currentListingKey(listing))return false;
  // A matching list only renews current membership for display. Keep the
  // original list and every SKU observation time intact for execution proofs.
  original.currentObservedAt=listing.observedAt;
  this.publishCatalog();
  return true;
 }
 async detail(campaign){
  id(campaign.id);const page=await this.open(LIST+`/view?refer=view&id=${campaign.id}&is_new_limit=1&operate_use_mode=0`);
  try{
   const products=[],seen=new Set();let declared=null,rules=null;
   for(let n=1;n<=100;n++){
    await this.ready(page);let slice=await until(async()=>{const s=await page.evaluate(detailSlice,{limited:isLimited(campaign)});return Number.isInteger(s.declared)&&(s.products.length||s.declared===0)&&s;},'活动详情商品未加载');
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
      const current=(await page.evaluate(detailSlice,{limited:isLimited(campaign)})).products.find(row=>row.productId===p.productId);
      requireThat(current,'DETAIL_CHANGED','待展开商品已变化');if(current.expanded)continue;
      const expand=page.locator(`tr[data-row-key="${p.key}"]`).locator('[aria-label="展开行"]');
      requireThat(await expand.count()===1&&await expand.isVisible(),'DETAIL_EXPANSION','规格展开入口不唯一或不可见');
      await expand.click();
     }
     slice=await until(async()=>{this.check();const s=await page.evaluate(detailSlice,{limited:isLimited(campaign)});return s.products.length===expectedIds.length&&s.products.every(p=>expectedIds.includes(p.productId)&&p.expanded&&p.skus.length)&&s;},'活动详情规格尚未完整展开');
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
     await this.identity(page);
     if(isLimited(campaign)&&typeof rules.autoRenew!=='boolean'&&active(campaign))rules.autoRenew=await this.readRenewal(campaign);
     let removalExport=null,removalExportError=null;
     try{removalExport=await this.readRemovalExport(page,campaign);}catch(error){
      if(['STOPPED','SHOP_MISMATCH','LOGIN_REQUIRED'].includes(error.code))throw error;
      removalExportError={code:error.code||'REMOVAL_EXPORT_READ',message:String(error.message).slice(0,500)};
     }
     return {complete:true,products,rules,observedAt:Date.now(),...(removalExport?{removalExport}:{}),...(removalExportError?{removalExportError}:{})};
    }
    const before=slice.products.map(p=>p.productId).join(',');await page.locator('li[title="下一页"] button:visible').click();
    await until(async()=>(await page.evaluate(detailSlice,{limited:isLimited(campaign)})).products.map(p=>p.productId).join(',')!==before,'详情翻页停滞');
   }
   throw new GuardError('DETAIL_LIMIT','活动详情超过页数上限');
  }catch(e){await this.fault(page,campaign.id,'detail',e);throw e;}finally{await page.close();}
 }
 async readRemovalExport(page,campaign){
  const link=page.getByText('点击下载详情',{exact:true}),count=await link.count();if(!count)return null;
  requireThat(count===1,'REMOVAL_EXPORT_SCOPE','剔除明细下载入口不唯一');
  const checkScope=async()=>{
   this.check();const url=new URL(page.url());
   requireThat(url.origin===this.base&&url.pathname===LIST+'/view'&&url.searchParams.get('id')===campaign.id,
    'REMOVAL_EXPORT_SCOPE','剔除明细页面与活动不一致');
   await this.identity(page);
   requireThat(/该活动中，有部分商品的优惠到手价会导致低价引流风险，已为您自动退出活动/.test(await page.locator('body').innerText()),
    'REMOVAL_EXPORT_SCOPE','页面未确认因低价风险退出活动');
  };
  await checkScope();
  const downloadPromise=page.waitForEvent('download',{timeout:30000});
  // Attach a rejection handler immediately if the click fails before download.
  downloadPromise.catch(()=>{});
  await link.click();const download=await downloadPromise;
  try{
   requireThat(/\.xlsx$/i.test(download.suggestedFilename()),'REMOVAL_EXPORT_FORMAT','平台剔除明细格式未知');
   const stream=await download.createReadStream();requireThat(stream,'REMOVAL_EXPORT_READ','平台剔除明细下载未完成');
   const chunks=[];let length=0;
   try{for await(const chunk of stream){length+=chunk.length;requireThat(length<=4*1024*1024,'REMOVAL_EXPORT_FORMAT','平台剔除明细超出大小上限');chunks.push(chunk);}}
   finally{stream.destroy();}
   const bytes=Buffer.concat(chunks),records=readRemovalWorkbook(bytes);
   await checkScope();
   return{source:'live-platform-removal-export',shopId:this.policy.shopId,campaignId:campaign.id,complete:true,observedAt:Date.now(),
    sha256:createHash('sha256').update(bytes).digest('hex'),records};
  }finally{await download.delete().catch(()=>{});}
 }
 async readRenewal(campaign){
  // The live detail page omits renewal. Its separate edit view exposes the
  // persisted, disabled radio. Only read it; never submit or change that form.
  const page=await this.open(LIST+`/edit?refer=edit&id=${id(campaign.id)}&operate_use_mode=0&limit_stock_type=1`);
  try{
   await page.locator('#title').waitFor();
   const s=await until(async()=>{const value=await page.evaluate(formSlice);return !value.busy&&value.title===campaign.name&&typeof value.rules.autoRenew==='boolean'&&value;},'活动续期状态未加载');
   const dates=s.dates.map(parseDate),url=new URL(page.url());
   requireThat(url.pathname===LIST+'/edit'&&url.searchParams.get('id')===campaign.id&&s.type===campaign.type&&
    dates.length===2&&dates[0]===campaign.startAt&&dates[1]===campaign.endAt,
    'LIMITED_RULES','续期回读页与目标活动不一致');
   await this.identity(page);return s.rules.autoRenew;
  }finally{await page.close();}
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
  // Reorder reads, not baselines. A still-active older campaign may acquire a
  // platform removal warning while unrelated newer activities remain healthy.
  const priorityIds=new Set(this.journal?new PriorityWatch(this.journal,this.policy.shopId).priorityCampaignIds(listing):[]);
  activeJobs.sort((a,b)=>Number(priorityIds.has(b.c.id))-Number(priorityIds.has(a.c.id)));
  let priorityRefreshRequired=false,priorityListing=null;
  const publish=()=>{
   this.inventory={listing,details,activeComplete:campaigns.filter(active).every(c=>details.has(c.id)),readOnlyReuseMaxAgeMs};
   this.publishCatalog();
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
      let detail,retried=false;
      try{detail=await this.detail(c);}catch(error){
       if(!active(c)||(error.code!=='LOAD_TIMEOUT'&&error.name!=='TimeoutError'))throw error;
       this.check();retried=true;
       this.journal?.event(null,'detail-read-retry',{shopId:this.policy.shopId,campaignId:c.id,code:error.code||'READ_TIMEOUT',message:String(error.message).slice(0,1000)},Date.now());
       // detail() closes its own page even on failure. Retry only a current
       // activity read on a new page with a new identity check. Historical
       // failures retain their read budget; prepare and submit never retry.
       detail=await this.detail(c);
      }
      requireThat(detail?.complete===true,'DETAIL_INCOMPLETE','活动详情未完整读取');
      if(retried)this.journal?.event(null,'detail-read-recovered',{shopId:this.policy.shopId,campaignId:c.id,message:'页面已重新读取并核对完整'},Date.now());
      this.cache.set(key,detail);this.journal?.putSettings('campaign:'+c.id,{key,detail});details.set(c.id,detail);publish();
      return {campaign:c,detail};
     }catch(e){
      if(e.code==='STOPPED')throw e;
      const error={campaignId:c.id,code:e.code||'READ_ERROR',message:e.message};errors.push(error);
      this.journal?.putSettings('campaign-attempt:'+c.id,{key,retryAt:Date.now()+15*60000,error});
     }finally{inFlight.delete(c.id);if(active(c))activeRead++;progress();}
   };
   // All six read slots must drain before a priority boundary can write.
   // This is a local load budget, not a claim about platform rate limits.
   const concurrency=6;
   for(let cursor=0;cursor<jobs.length&&!priorityRefreshRequired;cursor+=concurrency){
    this.check();if(onReadBatchStart)await onReadBatchStart();
    const results=await Promise.allSettled(jobs.slice(cursor,cursor+concurrency).map(worker));
    const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
    this.check();await boundary(results.map(r=>r.value).filter(Boolean),cursor+concurrency<jobs.length||remainingJobs>0);
   }
  };
  const riskJobs=activeJobs.filter(job=>priorityIds.has(job.c.id)),regularJobs=activeJobs.filter(job=>!priorityIds.has(job.c.id));
  await readGroup(riskJobs,'优先核对风险活动',regularJobs.length+historyJobs.length);
  await readGroup(regularJobs,'核对当前活动',historyJobs.length);
  await readGroup(historyJobs,'补读完整历史');
  // Network completion order must not change historical selection or batching.
  for(const c of campaigns){
   const detail=details.get(c.id);if(!detail)continue;
   for(const p of detail.products){
    if(this.policy.captureExistingOnly&&(!active(c)||p.removalConfirmed||p.removalAmbiguous))continue;
    const baseline={source:'verified-platform-history',complete:true,shopId:this.policy.shopId,productId:p.productId,name:p.name,campaignId:c.id,
     historyAt:c.startAt,generatedByGuardian:c.name.startsWith('守护2-'),observedAt:detail.observedAt,type:c.type,rules:detail.rules,skus:p.skus,
     ...(isLimited(c)?{activityLimit:p.activityLimit,durationMs:c.endAt-c.startAt}:{})};
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
 async loss(baseline,{fresh=false,reads=null}={}){
  if(fresh){
   const list=reads?.list||this.list.bind(this),detail=reads?.detail||this.detail.bind(this);
   const listing=await list({productId:baseline.productId}),details=new Map();
   requireThat(listing.complete===true,'ACTIVE_UNKNOWN','商品当前活动列表未完整读取');
   for(const c of listing.campaigns.filter(active))details.set(c.id,await detail(c));
   const reference=this.limitedReference(baseline);
   const alreadyActive=listing.campaigns.filter(active).some(c=>details.get(c.id)?.products.some(p=>p.productId===baseline.productId&&!p.removalConfirmed));
   if(reference.limited&&!alreadyActive){
    let previous=listing.campaigns.find(c=>c.id===reference.campaignId);
    if(!previous){
     // A removed member can vanish from product-filtered search altogether.
     // Old metadata is only a lookup hint: re-read the exact source activity
     // and download its current removal proof; never reuse a saved proof.
     const title=reference.title||this.inventory?.listing.campaigns.find(c=>c.id===reference.campaignId)?.name;
     const origin=await list(title?{title}:{});
     requireThat(origin.complete===true,'ACTIVE_UNKNOWN','原限量活动尚未完整重新核对');
     const matches=origin.campaigns.filter(c=>c.id===reference.campaignId);
     requireThat(matches.length<=1,'LIMITED_LOSS_UNPROVEN','原限量活动编号重复，不能确定退出结果');
     previous=matches[0];if(previous)listing.campaigns.push(previous);
    }
    if(previous&&!details.has(previous.id))details.set(previous.id,await detail(previous));
   }
   return this.lossFrom(baseline,listing,details,true,true);
  }
  requireThat(this.inventory?.activeComplete,'ACTIVE_UNKNOWN','全店有效活动尚未完整核对');
  const reference=this.limitedReference(baseline);
  if(reference.limited){
   const previous=this.inventory.listing.campaigns.find(c=>c.id===reference.campaignId);
   // Current-only scans omit ended campaigns. Inspect the precise last source
   // independently rather than treating an omitted row as a lost promotion.
   if(!previous||!this.inventory.details.has(previous.id))return this.loss(baseline,{fresh:true});
  }
  try{return this.lossFrom(baseline,this.inventory.listing,this.inventory.details,true);}
  catch(error){
   // Earlier reads can age while the remaining store is scanned. This is a
   // request for a new batch read, never an absence or execution proof.
   const campaign=this.inventory.listing.campaigns.find(c=>c.id===reference.campaignId);
   const detail=this.inventory.details.get(reference.campaignId),source=detail?.removalExport;
   const product=detail?.products.find(p=>p.productId===baseline.productId),now=Date.now();
   if(error.code==='LIMITED_LOSS_UNPROVEN'&&reference.limited&&detail?.complete===true&&!product?.soldOut&&
    source?.source==='live-platform-removal-export'&&source.complete===true&&source.shopId===this.policy.shopId&&
    source.campaignId===reference.campaignId&&source.observedAt>0&&now-source.observedAt>120000&&
    campaign?.risk===true&&campaign.endAt>now&&['进行中','未开始','已失效'].includes(campaign.status)&&
    source.records.some(r=>r.productId===baseline.productId))
    throw new GuardError('LOSS_EVIDENCE_EXPIRED','早先读取的本商品退出明细已过期，需要重新批量核对',
     {productId:baseline.productId,campaignId:reference.campaignId});
   throw error;
  }
 }
 async lossBatch(baselines){
  requireThat(baselines.length>0&&baselines.length<=50&&baselines.every(b=>b.shopId===this.policy.shopId)&&
   new Set(baselines.map(b=>b.productId)).size===baselines.length,'LOSS_UNPROVEN','批量失效核对范围无效');
  await this.ensure();
  // Store size, not this discount group's size, decides whether to share
  // bounded reads. A large shop can have many groups of only 1–5 products.
  if((this.inventory?.listing.campaigns.filter(active).length||0)>8)return this.scopedLossBatch(baselines);
  // Small queues benefit from exact product queries. Large queues share one
  // complete current inventory instead of reopening it for every product.
  if(baselines.length<=5){
   const results=[];
   for(let i=0;i<baselines.length;i+=2){
    const settled=await Promise.allSettled(baselines.slice(i,i+2).map(b=>this.loss(b,{fresh:true})));
    settled.forEach((r,j)=>results.push({productId:baselines[i+j].productId,...(r.status==='fulfilled'?{loss:r.value}:{error:r.reason})}));
   }
   return results;
  }
  // Reading every unrelated activity can outlive the evidence budget on a
  // large store. Use exact product queries before this happens, with shared
  // origin/detail reads scoped to this one batch.
  let inventory;
  try{inventory=await this.readFreshCurrentInventory();}
  catch(error){if(error.code==='BATCH_PROOF_EXPIRED')return this.scopedLossBatch(baselines);throw error;}
  const {listing,details,observedAt}=inventory;
  const results=[];
  for(let i=0;i<baselines.length;i+=2){
   const settled=await Promise.allSettled(baselines.slice(i,i+2).map(async b=>{
    const reference=this.limitedReference(b);
    // An ended limited activity needs its own removal proof; omission from
    // the active list cannot authorize replenishment after expiry or sellout.
    if(reference.limited&&!details.has(reference.campaignId))return this.loss(b,{fresh:true});
    return{...this.lossFrom(b,listing,details,true),observedAt};
   }));
   settled.forEach((r,j)=>results.push({productId:baselines[i+j].productId,...(r.status==='fulfilled'?{loss:r.value}:{error:r.reason})}));
  }
  return results;
 }
 async scopedLossBatch(baselines){
  await this.closeMonitorPages();
  const startedAt=Date.now(),cache=new Map(),results=new Array(baselines.length);
  let cursor=0,stopError=null,listReads=0,detailReads=0,cacheHits=0;
  const shared=async(key,read,refresh=true)=>{
   let pending=cache.get(key);
   if(pending)cacheHits++;
   if(!pending){
    pending=Promise.resolve().then(async()=>{
     const actualRead=()=>{if(key.startsWith('list:'))listReads++;else detailReads++;return read();};
     try{return await actualRead();}
     catch(error){
      if(error.name!=='TimeoutError'&&error.code!=='LOAD_TIMEOUT')throw error;
      // Only this read is retried, on the new page opened by list/detail.
      // Their finally blocks have closed the timed-out page before returning.
      this.check();return actualRead();
     }
    });cache.set(key,pending);
   }
   const value=await pending,age=Date.now()-value.observedAt;
   // Shared evidence retains its actual observation time. Refresh an older
   // origin independently; never renew its timestamp from a matching list.
   if(age>60000&&refresh){if(cache.get(key)===pending)cache.delete(key);return shared(key,read,false);}
   requireThat(age<=120000,'BATCH_PROOF_EXPIRED','重新读取后批量证据仍已过期');
   requireThat(value.complete===true&&Number.isFinite(age)&&age>=-5000,'ACTIVE_UNKNOWN','批量商品核对证据不完整');
   return value;
  };
  const worker=async()=>{
   while(!stopError){
    const i=cursor++;if(i>=baselines.length)return;
    const b=baselines[i],times=[];
    const reads={
     list:async query=>{
      const v=await shared('list:'+fingerprint(query),()=>this.list(query));times.push(v.observedAt);
      // loss() can add the exact origin to its own result; do not mutate a
      // list shared by another product's independent absence check.
      return{...v,campaigns:[...v.campaigns]};
     },
     detail:async campaign=>{
      const v=await shared('detail:'+fingerprint(campaign),()=>this.detail(campaign));times.push(v.observedAt);return v;
     }
    };
    try{
     this.check();
     const loss=await this.loss(b,{fresh:true,reads}),observedAt=Math.min(...times),age=Date.now()-observedAt;
     requireThat(times.length&&Number.isFinite(age)&&age>=-5000&&age<=120000,'BATCH_PROOF_EXPIRED','本批商品核对证据已过期');
     results[i]={productId:b.productId,loss:{...loss,observedAt}};
    }catch(error){
     results[i]={productId:b.productId,error};
     if(['STOPPED','LOGIN_REQUIRED','SHOP_MISMATCH'].includes(error.code))stopError=error;
    }
   }
  };
  // Only readers run concurrently. All six finish/close before any write.
  await Promise.all(Array.from({length:Math.min(6,baselines.length)},worker));
  if(stopError)throw stopError;
  this.journal?.event?.(null,'scoped-loss-batch-read',{shopId:this.policy.shopId,
   productIds:baselines.map(b=>b.productId),productCount:baselines.length,workerLimit:Math.min(6,baselines.length),
   listReads,detailReads,cacheHits,errors:results.filter(r=>r.error).length,elapsedMs:Date.now()-startedAt},Date.now());
  return results;
 }
 async readFreshCurrentInventory(){
  const listing=await this.listActive(),details=new Map();
  requireThat(listing.complete===true,'ACTIVE_UNKNOWN','批量核对的当前活动列表不完整');
  for(let i=0;i<listing.campaigns.length;i+=2){
   const settled=await Promise.allSettled(listing.campaigns.slice(i,i+2).map(async c=>{
    this.check();
    const previous=this.inventory?.listing.campaigns.find(p=>p.id===c.id);
    const saved=previous&&fingerprint(previous)===fingerprint(c)?this.inventory.details.get(c.id):null;
    const age=Date.now()-(saved?.observedAt||0);
    const d=saved?.complete===true&&age>=0&&age<=30000?saved:await this.detail(c);
    requireThat(d?.complete===true,'ACTIVE_UNKNOWN','批量核对的活动详情不完整');details.set(c.id,d);
   }));
   const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  }
  const after=await this.listActive();
  requireThat(after.complete===true&&currentListingKey(after)===currentListingKey(listing),'ACTIVE_CHANGED','批量核对期间当前活动发生变化，重新核对后才能创建');
  const observedAt=Math.min(listing.observedAt,after.observedAt,...[...details.values()].map(d=>d.observedAt));
  requireThat(Number.isFinite(observedAt)&&observedAt>0&&Date.now()-observedAt<=120000&&observedAt<=Date.now()+5000,
   'BATCH_PROOF_EXPIRED','批量核对耗时超过证据有效期，不能使用过期结果');
  return{listing,details,observedAt};
 }
 limitedReference(baseline){
  const task=this.journal?.list(this.policy.shopId).filter(t=>t.phase==='verified'&&t.plans.some(p=>p.productId===baseline.productId))
   .sort((a,b)=>b.receipt.verifiedAt-a.receipt.verifiedAt)[0];
  if(task&&task.receipt.verifiedAt>=(baseline.historyAt||0))return{limited:isLimited(task.plans.find(p=>p.productId===baseline.productId)),campaignId:task.receipt.campaignId,title:task.title};
  return{limited:isLimited(baseline),campaignId:baseline.campaignId};
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
  const reference=this.limitedReference(baseline);let removal=null,removalEvidence=null;
  if(reference.limited){
   const detail=details.get(reference.campaignId),p=detail?.products.find(p=>p.productId===baseline.productId);
   const source=detail?.removalExport,campaign=listing.campaigns.find(c=>c.id===reference.campaignId),now=Date.now();
   if(source?.source==='live-platform-removal-export'&&source.complete===true&&source.shopId===this.policy.shopId&&
    source.campaignId===reference.campaignId&&source.observedAt>0&&now-source.observedAt<=120000&&source.observedAt<=now+5000&&
    campaign?.risk===true&&campaign.endAt>now&&['进行中','未开始','已失效'].includes(campaign.status)&&!p?.soldOut)
    removal=source.records.find(r=>r.productId===baseline.productId)||null;
   if(removal)removalEvidence={source:source.source,complete:true,shopId:source.shopId,campaignId:source.campaignId,activityType:campaign.type,
    observedAt:source.observedAt,sha256:source.sha256,record:structuredClone(removal)};
   requireThat(p?.removalConfirmed===true&&p.removalRiskConfirmed===true&&!p.soldOut||removal,
    'LIMITED_LOSS_UNPROVEN','限量活动尚无本商品被异常剔除的明确证据；售罄、到期或不明消失不自动补量');
  }
  // Routine full/current-only listings describe the same missing product even
  // when ended history is omitted or rows reorder. Keep its retry budget stable.
  // Fresh product-scoped evidence retains campaign history to distinguish a
  // later platform removal from a previously verified restoration.
  return {complete,active:false,observedAt:Date.now(),...(removal?{removal,removalEvidence}:{}),lossKey:fingerprint({productId:baseline.productId,history:baseline.campaignId,related:related.sort(),...(removal?{removal}:{}),
   ...(productScoped?{status:previous?.status||'absent',campaigns:listing.campaigns.map(c=>[c.id,c.status,c.startAt,c.endAt,c.risk]).sort((a,b)=>a[0].localeCompare(b[0]))}: {})})};
 }
 async selectProduct(page,productId){return this.selectProducts(page,[productId]);}
 async selectProducts(page,productIds){
  const targets=new Set(productIds),selected=new Set();
  requireThat(targets.size===productIds.length&&targets.size>0&&targets.size<=50,'PICKER_SCOPE','批量选品需要1至50个唯一商品编号');
  await button(page,'添加商品').click();const picker=page.locator('.ecom-mcenter-drawer-open[class*="index-goodsDrawer--"]:visible');await picker.waitFor();
  const seen=new Set();
  for(let n=1;n<=100;n++){
   this.check();await this.ready(page);
   const rows=picker.locator('tr').filter({hasText:/商品ID[：:]\s*\d+/});
   await rows.first().waitFor();
   const texts=await rows.allInnerTexts();
   for(let i=0;i<texts.length;i++){
    const found=texts[i].match(/商品ID[：:]\s*(\d+)/)?.[1];requireThat(found&&!seen.has(found),'PICKER_PAGING','选品分页重复');seen.add(found);
    if(!targets.has(found))continue;
    requireThat(!/(?:商品状态[：:]\s*)?已下架/.test(texts[i]),'OFF_SHELF','商品已明确下架');
    requireThat(!/当前已参与单品直降/.test(texts[i]),'ALREADY_ACTIVE','商品已有有效活动');
    const box=rows.nth(i).getByRole('checkbox');requireThat(await box.count()===1&&await box.isEnabled(),'PICKER_DISABLED','商品当前不能唯一选择');
    await box.check();selected.add(found);
    if(selected.size===targets.size){await button(picker,'确定').click();await picker.waitFor({state:'hidden'});return;}
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
 async precheckBatch(baselines){
  requireThat(baselines.length>0&&baselines.length<=50&&baselines.every(b=>b.shopId===this.policy.shopId)&&
   new Set(baselines.map(b=>b.productId)).size===baselines.length,'PRECHECK_MEMBERSHIP','批量预查商品必须唯一且属于当前店铺');
  this.progress={stage:'批量读取当前完整规格',products:baselines.length,at:Date.now()};
  const page=await this.open(LIST+'/create');
  try{
   await page.locator('#title').waitFor();const initial=await page.evaluate(formSlice);
   requireThat(!initial.counts.some(n=>n>0)&&!initial.cells.some(c=>c.rows.length),'DRAFT_NOT_EMPTY','新的批量预查页已有商品');
   await this.selectProducts(page,baselines.map(b=>b.productId));await this.expand(page);
   const {products,snapshot}=await collectForm(page,{precheck:true});
   requireThat(products.length===baselines.length&&products.every(p=>baselines.some(b=>b.productId===p.productId))&&
    snapshot.counts.length&&snapshot.counts.every(n=>n===baselines.length),'PRECHECK_MEMBERSHIP','批量预查商品集合不一致');
   await this.identity(page);const observedAt=Date.now();
   return baselines.map(b=>{
    const p=products.find(p=>p.productId===b.productId);
    return{shopId:this.policy.shopId,productId:b.productId,complete:true,observedAt,offShelf:p.offShelf,skus:p.skus};
   });
  }catch(e){await this.fault(page,baselines[0].productId+'-batch','precheck',e);throw e;}
  finally{if(!page.isClosed())await page.close();}
 }
 async radio(page,label){
  const control=page.locator('label').filter({hasText:new RegExp('^'+label+'$')}).filter({has:page.locator('input[type="radio"]')});
  requireThat(await control.count()===1,'RULE_CONTROL',`无法唯一读取 ${label}`);
  if(!await control.locator('input').isChecked())await control.click();
  await until(()=>control.locator('input').isChecked(),`${label} 未生效`);
 }
 async rules(page,plan){
  if(!isLimited(plan))await this.radio(page,'不设置');await this.radio(page,'不限购');
  const more=button(page,'更多配置（订单取消时间、是否预热）');
  if(await more.count()===1&&await more.getAttribute('aria-expanded')==='false')await more.click();
  await this.radio(page,'不预热');
  const select=page.locator('.ecom-mcenter-select').filter({has:page.locator('#order_expire_time')});
  await select.locator('.ecom-mcenter-select-selection-item').waitFor();
  if((await select.locator('.ecom-mcenter-select-selection-item').innerText()).trim()!==plan.rules.orderMinutes+'分钟'){
   await select.locator('.ecom-mcenter-select-selector').click();
   await page.locator('.ecom-mcenter-select-dropdown:visible .ecom-mcenter-select-item-option').filter({hasText:new RegExp('^'+plan.rules.orderMinutes+'分钟$')}).click();
  }
  const renew=page.locator('#renew_switch_on');
  if(isLimited(plan)||await renew.count())await this.radio(page,isLimited(plan)&&plan.rules.autoRenew?'(?:开启|开启自动续期)(?:\\s*推荐)?':'不开启');
 }
 async setDates(page,plan){
  if(!isLimited(plan)){
   await page.locator('input[placeholder="开始日期"]').click();await button(page,'近48小时').click();return;
  }
  const readDates=async()=>{const values=(await page.evaluate(formSlice)).dates;return values.length===2&&values.every(Boolean)?values.map(parseDate):[];};
  const matches=dates=>dates.length===2&&dates[1]-dates[0]===plan.durationMs&&dates[0]>Date.now()-240000&&dates[0]<=Date.now()+300000;
  if(matches(await readDates()))return;
  const startInput=page.locator('input[placeholder="开始日期"]'),endInput=page.locator('input[placeholder="结束日期"]');
  requireThat(await startInput.count()===1&&await endInput.count()===1,'DRAFT_TIME','日期控件不唯一');
  requireThat(await startInput.isEnabled()&&await endInput.isEnabled(),'DRAFT_TIME','活动日期控件不可用，未提交');
  // Some shops use an inputReadOnly range picker. Its own shortcuts update
  // React state as well as the visible dates; never remove readonly or write
  // the DOM value behind the platform's controls.
  const days=plan.durationMs/86400000;
  if(Number.isInteger(days)){
   await startInput.click();
   const shortcut=page.getByText(`近${days}天`,{exact:true}).filter({visible:true});
   try{await shortcut.waitFor({state:'visible',timeout:2000});}catch(error){if(error.name!=='TimeoutError')throw error;}
   if(await shortcut.count()===1){
    await shortcut.click();
    const confirm=page.locator('[class*="picker-dropdown"]:visible').getByRole('button',{name:/^确\s*定$/});
    if(await confirm.count()===1)await confirm.click();
    await page.locator('#title').click();
    await until(async()=>matches(await readDates()),'平台日期选择器未应用原活动时长，未提交',5000);
    return;
   }
   requireThat(await shortcut.count()===0,'DRAFT_TIME','日期快捷选项不唯一，未提交');
   await page.keyboard.press('Escape');
  }
  if(!await startInput.isEditable()||!await endInput.isEditable()){
   await chooseReadonlyDateRange(page,plan.durationMs);
   requireThat(matches(await readDates()),'DRAFT_TIME','日期时长未核对，未提交');return;
  }
  const format=time=>new Date(time+8*3600000).toISOString().slice(0,19).replaceAll('-','/').replace('T',' ');
  const start=Math.floor(Date.now()/1000)*1000;
  for(const [label,time] of [['开始日期',start],['结束日期',start+plan.durationMs]]){
   const input=page.locator(`input[placeholder="${label}"]`);requireThat(await input.count()===1,'DRAFT_TIME','日期控件不唯一');
   await input.fill(format(time));await input.press('Enter');
  }
  await page.locator('#title').click();
  await until(async()=>{const d=(await page.evaluate(formSlice)).dates.map(parseDate);return d.length===2&&d[0]===start&&d[1]===start+plan.durationMs;},'限量活动时间尚未生效');
 }
 async fillProductLimits(page,plans){
  requireThat(plans.length&&plans.every(isLimited),'LIMITED_QUANTITY','商品限量只能用于限量活动');
  const column=await page.evaluate(()=>{
   const found=[...document.querySelectorAll('tr')].filter(r=>r.querySelector('th')).flatMap(r=>[...r.cells].map((c,i)=>({i,t:c.textContent.replace(/\s/g,'')}))).filter(c=>c.t==='活动限量');
   return found.length===1?found[0].i:null;
  });
  requireThat(Number.isInteger(column),'LIMITED_QUANTITY','活动限量列未能唯一定位');
  // Quantity belongs to the product, not each SKU. Collapse the SKU rows,
  // locate every live control by product ID, then perform full SKU proof once.
  const sw=page.getByRole('switch');requireThat(await sw.count()===1,'EXPANSION_UNKNOWN','规格展开开关不唯一');
  if(await sw.getAttribute('aria-checked')==='true')await sw.click();
  await until(async()=>await sw.getAttribute('aria-checked')==='false','规格未折叠');
  await page.evaluate(scrollForm,0);await delay(150);
  const filled=new Set(),deadline=Date.now()+60000;let cursor=0;
  while(filled.size<plans.length){
   this.check();requireThat(Date.now()<deadline,'LIMITED_QUANTITY','商品限量填写未在限定时间内完成');
   const s=await page.evaluate(formSlice),rows=s.cells.flatMap(c=>c.rows).filter(r=>r.kind==='product');
   requireThat(s.counts.length&&s.counts.every(n=>n===plans.length)&&rows.every(r=>plans.some(p=>p.productId===r.productId))&&
    new Set(rows.map(r=>r.productId)).size===rows.length,'DRAFT_MEMBERSHIP','填写限量时商品集合变化');
   requireThat(!s.cells.some(c=>c.rows.some(r=>r.kind==='sku')),'EXPANSION_UNKNOWN','规格折叠状态不符');
   const target=rows.find(r=>!filled.has(r.productId));
   if(!target){
    const end=Math.max(0,...s.cells.map(c=>c.top+c.height));
    requireThat(end>cursor&&end<s.total,'LIMITED_QUANTITY','限量商品行未完整读取');
    cursor=end;await page.evaluate(scrollForm,cursor);await delay(120);continue;
   }
   const plan=plans.find(p=>p.productId===target.productId);
   const row=page.locator('tr[class*="index-productRow--"]').filter({hasText:new RegExp('ID[：:]\\s*'+plan.productId+'(?!\\d)')});
   requireThat(await row.count()===1,'LIMITED_QUANTITY','限量商品行不唯一');
   const input=row.locator('td').nth(column).locator('input[role="spinbutton"]');
   requireThat(await input.count()===1&&await input.isEnabled(),'LIMITED_QUANTITY','商品总限量控件不可用');
   await input.fill(String(plan.activityLimit));await input.press('Tab');
   await until(async()=>{const s=await page.evaluate(formSlice);return s.cells.flatMap(c=>c.rows).some(r=>r.kind==='product'&&r.productId===plan.productId&&r.activityLimit===plan.activityLimit);},'商品总限量未生效');
   filled.add(plan.productId);
  }
  await this.expand(page);
 }
 async observeDraft(task,page,{originalRisk=false,priceReview=false}={}){
  const {products,snapshot}=await collectForm(page,{originalRisk});
  requireThat(snapshot.counts.length&&snapshot.counts.every(n=>n===task.plans.length)&&snapshot.mode==='Excel批量导入'&&snapshot.byDiscount&&snapshot.renew===(isLimited(task.plans[0])&&task.plans[0].rules.autoRenew),'DRAFT_RULES',
   '导入数量、打折方式或续期规则未核对：'+JSON.stringify({expectedCount:task.plans.length,counts:snapshot.counts,mode:snapshot.mode,priceModes:snapshot.priceModes,byDiscount:snapshot.byDiscount,renew:snapshot.renew}));
  const warnings=draftPriceWarnings(products,snapshot.warnings,{priceReview});
  const dates=snapshot.dates.map(parseDate);requireThat(dates.length===2,'DRAFT_TIME','草稿时间不完整');
  return {kind:'draft',shopId:this.policy.shopId,title:snapshot.title,type:snapshot.type,rules:snapshot.rules,startAt:dates[0],endAt:dates[1],
   complete:true,observedAt:Date.now(),rows:bindFormProducts(products,task.plans),warnings,dialogs:snapshot.dialogs,
   ...(isLimited(task.plans[0])?{productLimits:products.map(p=>({productId:p.productId,activityLimit:p.activityLimit}))}:{})};
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
   await this.setDates(page,task.plans[0]);
   await this.identity(page);this.check();this.assertWrite();
   this.journal.assertPricePlans(task.shopId,task.plans);
   const file=page.locator('input[type="file"][accept*=".xlsx"]');requireThat(await file.count()===1,'UPLOAD_CONTROL','官方导入控件不唯一');
   await file.setInputFiles({name:task.title+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:makeWorkbook(task.plans)});
   const expected=`全部${task.plans.length}个商品（共${task.plans.reduce((n,p)=>n+p.skus.length,0)}个规格）上传成功`;
   await until(async()=>{this.check();const t=(await page.locator('body').innerText()).replace(/\s/g,'');
    if(/全部商品或规格上传失败|查看上传失败信息/.test(t))throw new GuardError('IMPORT_REJECTED','平台拒绝部分原折扣；未调整价格或提交');return t.includes(expected);},'导入未返回完整成功数量',60000);
   await this.rules(page,task.plans[0]);await this.expand(page);
   if(isLimited(task.plans[0]))await this.fillProductLimits(page,task.plans);
   await this.identity(page);
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
   observedAt:d.observedAt,type:campaign.type,rules:d.rules,rows:d.products.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),startAt:campaign.startAt,endAt:campaign.endAt,
   ...(isLimited(campaign)?{productLimits:d.products.map(p=>({productId:p.productId,activityLimit:p.activityLimit}))}:{})};
 }
 async auditVerifiedTask(task){
  requireThat(task?.phase==='verified'&&task.shopId===this.policy.shopId&&task.receipt?.campaignId&&task.receipt.verifiedAt>0,
   'CONVERSION_INCOMPLETE','只有已独立回读成功的任务才能交接持续守护');
  this.progress={stage:'核对迁移后当前商品状态',taskId:task.id,at:Date.now()};
  const listing=await this.list({title:task.title}),matches=listing.campaigns.filter(c=>c.name===task.title);
  requireThat(listing.complete&&matches.length===1&&matches[0].id===task.receipt.campaignId,
   'CONVERSION_INCOMPLETE','迁移活动与原成功回执不一致，保留待核实');
  const campaign=matches[0],detail=await this.detail(campaign),now=Date.now();
  requireThat(detail.complete&&detail.observedAt>0&&now-detail.observedAt<=120000&&detail.observedAt<=now+5000,
   'CONVERSION_INCOMPLETE','迁移后状态尚未完整读取');
  requireThat(new Set(detail.products.map(p=>p.productId)).size===detail.products.length&&
   detail.products.every(p=>task.plans.some(plan=>plan.productId===p.productId)),
   'CONVERSION_INCOMPLETE','迁移活动的商品集合出现未知变化');
  const products=[];
  for(const plan of task.plans){
   const product=detail.products.find(p=>p.productId===plan.productId);
   requireThat(!product?.removalAmbiguous,'CONVERSION_INCOMPLETE','迁移商品部分规格状态不明');
   if(active(campaign)&&product&&!product.removalConfirmed){
    const observation={complete:true,shopId:this.policy.shopId,title:campaign.name,campaignId:campaign.id,status:campaign.status,
     observedAt:detail.observedAt,type:campaign.type,rules:detail.rules,startAt:campaign.startAt,endAt:campaign.endAt,
     rows:product.skus.map(s=>({...s,productId:plan.productId})),
     ...(isLimited(campaign)?{productLimits:[{productId:plan.productId,activityLimit:product.activityLimit}]}:{})};
    const receipt=proveReadback([plan],observation,{title:task.title});
    products.push({productId:plan.productId,status:'current',observedAt:detail.observedAt,receipt});
   }else{
    const source=detail.removalExport;
    const removal=source?.source==='live-platform-removal-export'&&source.complete===true&&source.shopId===task.shopId&&
     source.campaignId===campaign.id&&source.observedAt>0&&now-source.observedAt<=120000&&source.observedAt<=now+5000&&
     campaign.risk===true&&campaign.endAt>now&&['进行中','未开始','已失效'].includes(campaign.status)&&!product?.soldOut&&
     source.records.find(r=>r.productId===plan.productId);
    requireThat(removal,'CONVERSION_INCOMPLETE','迁移商品缺失且没有当前平台的明确退出证明，保留待核实');
    products.push({productId:plan.productId,status:'removed',observedAt:source.observedAt,removal,exportSha256:source.sha256});
   }
  }
  return{complete:true,shopId:task.shopId,taskId:task.id,campaignId:campaign.id,observedAt:detail.observedAt,products};
 }
 async cancelCampaign(campaign,beforeBoundary){
  id(campaign.id);requireThat(active(campaign),'CONVERSION_SCOPE','仅作废迁移清单中的当前活动');
  const page=await this.open(LIST);
  try{
   await page.locator('input[placeholder="请输入活动名称"]').fill(campaign.name);
   await button(page,'查询').click();
   const control=page.locator(`[data-btm="operation_set_failed_${campaign.id}"]`);
   await control.waitFor();
   const rows=await page.evaluate(listSlice),row=rows.find(r=>r.ids.length===1&&r.ids[0]===campaign.id);
   requireThat(row&&row.name===campaign.name&&row.type===campaign.type&&row.status===campaign.status&&
    parseDate(row.times[0])===campaign.startAt&&parseDate(row.times[1])===campaign.endAt,'CONVERSION_CHANGED','作废入口与已核对的活动不一致');
   requireThat(await control.count()===1,'CONVERSION_SCOPE','作废入口不唯一');
   await control.click({trial:true});this.check();this.assertWrite();await beforeBoundary('intent');await control.click();
   const dialog=page.getByRole('dialog').filter({visible:true});
   await dialog.waitFor();
   const text=await dialog.innerText();
   requireThat(await dialog.count()===1&&/作废|确定失效活动|确定失效该活动/.test(text)&&!/删除商品|删除店铺/.test(text),'CONVERSION_CONFIRM','作废确认内容未核对');
   const confirm=dialog.getByRole('button',{name:/^(?:确\s*定|确\s*认|确\s*认\s*作\s*废|作\s*废)$/});
   requireThat(await confirm.count()===1,'CONVERSION_CONFIRM','作废确认入口不唯一');
   await confirm.click({trial:true});this.check();this.assertWrite();await beforeBoundary('confirm');await confirm.click();
   await dialog.waitFor({state:'hidden'});
   // The confirmation can disappear before the request is sent or finishes.
   // Keep this page alive until the same activity shows a terminal state.
   await until(async()=>{
    const rows=await page.evaluate(listSlice),row=rows.find(r=>r.ids.length===1&&r.ids[0]===campaign.id);
    return row&&row.name===campaign.name&&row.type===campaign.type&&['已作废','已失效','已结束'].includes(row.status);
   },'作废确认后尚未读到该活动的失效状态');
  }catch(error){await this.fault(page,campaign.id,'cancel',error);throw error;}
  finally{await page.close();}
 }
 async release(task){if(['unknown','submitting','verifying'].includes(task.phase))return;const page=this.drafts.get(task.id);this.drafts.delete(task.id);if(page)await page.close();}
 async probe(){const page=await this.open(LIST);try{return await this.identity(page);}finally{await page.close();}}
}
