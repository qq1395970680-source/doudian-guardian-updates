import {wakeVerification} from './verification-schedule.mjs';
import {activeCareRecoveryGrant,setCareRecoveryPolicy} from './care-recovery-policy.mjs';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Journal} from './journal.mjs';
import {DedicatedBrowser} from './browser.mjs';
import {DoudianPlatform,LIST} from './platform.mjs';
import {GuardianService} from './service.mjs';
import {requireThat,id} from './policy.mjs';
import {buildCatalog} from './catalog.mjs';
import {withCatalogAttention} from './catalog-attention.mjs';
import {hiddenInactiveProductIds,visibleCatalog} from './catalog-visibility.mjs';
import {blockerPriceOptions,buildActivityPriceComparison,activityPriceBasis} from './activity-price-comparison.mjs';
import {manualPriceOption,manualPriceEditable} from './manual-price-option.mjs';
import {workspaceOwnership} from './workspace-ownership.mjs';
import {recoveryRequests} from './recovery-requests.mjs';
import {buildRecoveryBlockers} from './recovery-blockers.mjs';
import {AccountRegistry} from './accounts.mjs';
import {activePriceIncreaseGrant,setPriceIncreasePolicy} from './price-increase-policy.mjs';
import {buildRecoveryHistory} from './recovery-history.mjs';
import {checkForUpdates,UPDATE_REPOSITORY} from './updates.mjs';
import {projectBuild} from './build.mjs';
import {makeTransfer,validateTransfer,importTransfer,TRANSFER_MAX_BYTES} from './migration.mjs';
import {exportDiagnostics} from './diagnostics.mjs';
import {authenticationView,markAuthenticationRequired,markAuthenticated} from './authentication.mjs';
import {activeOriginalRebuildGrant,setOriginalRebuildPolicy} from './original-rebuild-policy.mjs';
import {buildRecoveryIssues} from './recovery-issues.mjs';
import {activeOriginalPriceRecoveryGrant,setOriginalPriceRecoveryPolicy} from './original-price-recovery-policy.mjs';
import {activeDualActivityCareGrant,setDualActivityCarePolicy,getDualActivityDecision,dualPriceApprovalReady,dualPriceProposalReady} from './dual-activity-recovery.mjs';
import {buildRecoveryWorkspace,workspaceSchemes} from './recovery-workspace.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function createApp({config=null,rootDir=root,port=19417,runtime=join(rootDir,'runtime'),dependencies={},resumeOnUpgrade=false}={}){
 const sourceBuild=await projectBuild(root),version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
 await mkdir(runtime,{recursive:true});
 const journal=dependencies.journal||new Journal(join(runtime,'guardian.sqlite')),accounts=new AccountRegistry(journal);
 if(config?.shopId)accounts.register(config,config.profileKey||'shop-'+id(config.shopId),{...config,captureExistingOnly:config.captureExistingOnly===true});
 const browser=dependencies.browser||new DedicatedBrowser(runtime),token=randomBytes(32).toString('hex'),instance=randomBytes(16).toString('hex');
 const startedAt=Date.now(),runtimeBuild={version,sourceBuild,instance,startedAt};
 journal.setDiagnosticContext(runtimeBuild);browser.diagnosticContext=Object.freeze(runtimeBuild);
 let shopId=null,policy={},saved={},platform,service,connection=null,action=null,lastAction=null,closing=false,loginProfile=null,loginExpectedShop=null,migrationPreview=null,exportingDiagnostics=false;
 function bind(account){
  shopId=account?.shopId||null;saved=shopId?journal.settings(shopId)||{}:{};
  const enabled=saved.executionEnabled===true||saved.cutoverConfirmed===true;
  policy={...account,shopId,liveEnabled:enabled,cutoverConfirmed:enabled};
  platform=dependencies.platformFactory?.(policy)||dependencies.platform||new DoudianPlatform({browser,policy,journal});
  service=dependencies.serviceFactory?.({policy,platform})||dependencies.service||new GuardianService({journal,platform,policy,immediate:true});
  const bound=platform,boundShop=shopId;
  const authenticationFailed=error=>{
   if(bound!==platform)return;
   connection=null;markAuthenticationRequired(journal,boundShop,error);service.stop();platform.stopping=true;platform.cancelReads?.();
  };
  platform.onAuthenticationFailure=authenticationFailed;service.onAuthenticationFailure=authenticationFailed;
  platform.onAuthenticated=identity=>{if(bound===platform&&identity.shopId===boundShop){connection=identity;markAuthenticated(journal,identity);}};
  service.canRunImmediate=()=>!action&&!authView().required&&connection?.shopId===boundShop;
  connection=null;migrationPreview=null;
 }
 bind(accounts.selected());
 const authView=()=>authenticationView({shopId,record:shopId?journal.settings('authentication:'+shopId):null,connection,
  lastRun:service.status().lastRun,lastAction,readHealth:platform.readHealth?.(),loginOpen:browser.loginMode===true,persistence:browser.sessionPersistence||null});
 const acceptConnection=identity=>{connection=identity;markAuthenticated(journal,identity,Date.now(),{force:true});return identity;};
 const displayContext=()=>{
  const tasks=shopId?journal.list(shopId):[],reviews=shopId?journal.priceReviews(shopId):[],queue=shopId?recoveryRequests(journal,shopId):{items:[],paused:false};
  const checks=shopId?journal.productChecks(shopId):[];
  const raw=buildCatalog({shopId,inventory:platform.inventory,observation:shopId?journal.settings('catalog-view:'+shopId):null,
   histories:shopId?journal.histories(shopId):[],tasks,checks,excluded:policy.excludedProductIds||[]});
  const hiddenProductIds=hiddenInactiveProductIds({shopId,checks,catalog:raw});
  let catalog=visibleCatalog(raw,hiddenProductIds);const hidden=[...new Set([...hiddenProductIds,...(policy.excludedProductIds||[])])];
  const dualEnabled=!!activeDualActivityCareGrant(journal,shopId),dualDecisions=new Map();
  if(dualEnabled){
   const reader=Object.create(journal),byId=new Map(reviews.map(r=>[r.id,r])),targets=new Map(journal.priceTargets(shopId).map(r=>[r.productId,r])),settings=new Map();let histories=null;
   reader.list=targetShop=>targetShop===shopId?tasks:journal.list(targetShop);reader.priceReview=reviewId=>byId.get(reviewId)||null;
   reader.priceTarget=(targetShop,productId)=>targetShop===shopId?targets.get(productId)||null:journal.priceTarget(targetShop,productId);
   reader.histories=targetShop=>targetShop===shopId?(histories??=journal.histories(shopId)):journal.histories(targetShop);
   reader.productChecks=targetShop=>targetShop===shopId?checks:journal.productChecks(targetShop);
   reader.settings=key=>{if(!settings.has(key))settings.set(key,journal.settings(key));return settings.get(key);};
   for(const productId of new Set([...catalog.products.map(p=>p.productId),...reviews.map(r=>r.productId)]))dualDecisions.set(productId,getDualActivityDecision(reader,shopId,productId));
  }
  const ownership=workspaceOwnership({shopId,products:catalog.products,reviews,tasks,checks,requests:queue.items,hiddenProductIds:hidden,careEnabled:!!activeCareRecoveryGrant(journal,shopId),dualEnabled,dualDecisions});
  for(const [productId,assignment] of ownership.byProduct){
    if(service.priceApprovalIntent?.(productId)?.state!=='pending')continue;
    ownership.byProduct.set(productId,{...assignment,owner:'blockers',category:'processing',carePending:true,blockedReason:'已收到确切价格确认，后台正在重新核验；一致后自动继续恢复。'});
    ownership.priceReviewIds=ownership.priceReviewIds.filter(id=>id!==assignment.reviewId);ownership.priceProductIds=ownership.priceProductIds.filter(id=>id!==productId);
  }
  catalog=withCatalogAttention({shopId,catalog,ownership,reviews,tasks,checks,requests:queue.items,dualDecisions,hiddenProductIds:hidden,now:Date.now()});
  const investigationsByTask=new Map(tasks.filter(t=>['unknown','submitting','verifying'].includes(t.phase)).map(t=>[t.id,journal.settings('submission-full-investigation:'+shopId+':'+t.id)||journal.settings('submission-investigation:'+shopId+':'+t.id)]));
  return{catalog,hiddenProductIds:hidden,reviews,tasks,checks,requests:queue.items,requestsPaused:queue.paused,ownership,dualEnabled,dualDecisions,investigationsByTask};
 };
 const originalPricesOnly=()=>!!activeOriginalPriceRecoveryGrant(journal,shopId);
 const blockerView=(options={},context=displayContext())=>buildRecoveryBlockers({shopId,catalog:context.catalog,
  tasks:context.tasks,reviews:context.reviews,checks:context.checks,requests:context.requests,requestsPaused:context.requestsPaused,ownership:context.ownership,hiddenProductIds:context.hiddenProductIds,
  targets:shopId?journal.priceTargets(shopId):[],originalPricesOnly:originalPricesOnly(),careEnabled:!!activeCareRecoveryGrant(journal,shopId),...options});
 const workspaceView=(options={},context=displayContext())=>buildRecoveryWorkspace({shopId,...context,...options});
 const snapshot=()=>{const context=displayContext(),{hiddenProductIds,catalog}=context,viewNow=Date.now(),blockers=blockerView({pageSize:1},context);return({version,build:'isolated-headless-journal',sourceBuild,instance,startedAt,shopId,name:policy.name||null,connection:authView().required?null:connection,authentication:authView(),action,lastAction,
  ...service.status(),running:service.running,busy:service.busy,progress:platform.progress,excluded:policy.excludedProductIds||[],
  accounts:accounts.list(),originalRestoreAuthorized:policy.originalRiskAllowed===true,loginOpen:browser.loginMode===true,
  automaticPriceIncreaseEnabled:!!activePriceIncreaseGrant(journal,shopId)||!!activeCareRecoveryGrant(journal,shopId)||context.dualEnabled,careRecoveryEnabled:!!activeCareRecoveryGrant(journal,shopId),dualActivityCareEnabled:context.dualEnabled,
  automaticOriginalRebuildEnabled:!!activeOriginalRebuildGrant(journal,shopId),
  originalPriceRecoveryEnabled:originalPricesOnly(),
  scanLoad:platform.readBudget?.()||null,
  campaignRule:shopId?journal.settings('campaign-policy:'+shopId)?.target||null:null,
  campaignConversion:shopId?(()=>{const s=journal.settings('campaign-conversion:'+shopId);return s?{status:s.status,total:s.products.length,verified:s.products.filter(p=>p.phase==='verified').length,updatedAt:s.updatedAt}:null;})():null,
  updates:{repository:UPDATE_REPOSITORY,currentVersion:version},
  priceReviewsPending:context.ownership.priceReviewIds.length,
  recoveryWorkspaceCounts:workspaceView({pageSize:1},context).counts,
  priceRechecksPending:shopId?journal.priceRecheckProgress(shopId,{hiddenProductIds,products:catalog.products,hideExpiredAt:viewNow,hideUnconfirmed:originalPricesOnly()}).pending:0,
  recoveryBothBlocked:blockers.counts.bothBlocked,recoveryBlockersTotal:blockers.counts.total,
  events:shopId?journal.events(150).filter(e=>e.detail?.shopId===shopId||e.task&&journal.get(e.task)?.shopId===shopId).slice(0,30):[]});};
 async function background(kind,fn){
  requireThat(!action&&!service.busy,'BUSY','当前任务完成前不能执行另一操作');action=kind;
  void(async()=>{try{const result=await fn();lastAction={kind,ok:true,at:Date.now(),result};}
   catch(e){lastAction={kind,ok:false,at:Date.now(),code:e.code||'ERROR',message:e.message};if(e.code==='LOGIN_REQUIRED'){connection=null;markAuthenticationRequired(journal,shopId,e);}journal.event(null,'control-error',{shopId,...lastAction});}
   finally{action=null;service.wakeImmediate?.();}})();
 }
 async function readCurrent(){
  platform.stopping=false;acceptConnection(await platform.probe());const d=await platform.discover({historyReadLimit:0,
   onReadBoundary:async()=>{
    if(!service.immediateEnabled||!policy.liveEnabled||!policy.cutoverConfirmed||!policy.originalRiskAllowed)return;
    const result=await service.runImmediate({atBoundary:true});
    if(result.submitted||result.refreshRequired)return{refreshRequired:true,listing:await platform.listActive()};
   }});
  for(const b of d.baselines)journal.remember(b);return{products:journal.histories(shopId).length,complete:d.activeComplete,errors:d.errors};
 }
 const html=(await readFile(join(rootDir,'public','index.html'),'utf8')).replace('__SESSION_TOKEN__',token).replace('__SERVICE_INSTANCE__',instance);
 let boundPort;
 const server=createServer(async(req,res)=>{
  const host='127.0.0.1:'+boundPort,origin='http://'+host;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'nonce-"+token+"'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  try{
   if(closing){res.setHeader('Connection','close');json(503,{ok:false,code:'CLOSING',message:'后台正在维护重启'});return;}
   requireThat(req.headers.host===host,'HOST_REJECTED','只接受本机工作台访问');
   const requestUrl=new URL(req.url,origin),path=requestUrl.pathname;
   if(req.method==='GET'&&path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
   const assets={'/app.js':['app.js','text/javascript; charset=utf-8'],'/price-reviews.js':['price-reviews.js','text/javascript; charset=utf-8'],'/migration.js':['migration.js','text/javascript; charset=utf-8'],'/app.css':['app.css','text/css; charset=utf-8'],'/guardian.png':['guardian.png','image/png']};
   assets['/price-review-card.js']=['price-review-card.js','text/javascript; charset=utf-8'];
   assets['/activity-prices.js']=['activity-prices.js','text/javascript; charset=utf-8'];
   assets['/blocker-prices.js']=['blocker-prices.js','text/javascript; charset=utf-8'];
   assets['/recovery-blockers.js']=['recovery-blockers.js','text/javascript; charset=utf-8'];
   assets['/recovery-workspace.js']=['recovery-workspace.js','text/javascript; charset=utf-8'];
   if(req.method==='GET'&&assets[path]){const[file,type]=assets[path];res.writeHead(200,{'Content-Type':type});res.end(await readFile(join(rootDir,'public',file)));return;}
   if(req.method==='GET'&&path==='/api/status'){json(200,snapshot());return;}
   if(req.method==='GET'&&path==='/api/recovery-workspace'){
    const q=requestUrl.searchParams;json(200,workspaceView({scope:q.get('scope')||'confirm',page:q.get('page')??0,pageSize:q.get('size')??10,query:q.get('q')||''}));return;
   }
   if(req.method==='GET'&&path==='/recoveries.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await readFile(join(rootDir,'public','recoveries.js'),'utf8'));return;}
   if(req.method==='GET'&&path==='/api/recoveries'){
    const q=requestUrl.searchParams;
    json(200,buildRecoveryHistory({shopId,tasks:shopId?journal.list(shopId):[],reviews:shopId?journal.priceReviews(shopId):[],
     filter:q.get('filter')||'verified',query:q.get('q')||'',page:q.get('page'),pageSize:q.get('size')||12}));return;
   }
   if(req.method==='GET'&&path==='/api/price-reviews'){
    const q=requestUrl.searchParams,scope=['pending','history'].includes(q.get('scope'))?q.get('scope'):null,context=displayContext(),{catalog,hiddenProductIds}=context;
    const pricePage=journal.priceReviewPage(shopId,{scope,allowedReviewIds:scope==='pending'?context.ownership.priceReviewIds:null,page:q.get('page')??0,pageSize:q.get('size')??10,direction:q.get('direction')??'all',recheckPage:q.get('recheckPage')??0,hiddenProductIds,products:catalog.products,hideExpiredAt:Date.now(),hideUnconfirmed:scope?false:originalPricesOnly()});
    const tracked=new Set(pricePage.rechecks.trackedPendingProductIds);
    json(200,{...pricePage,recoveryIssues:scope?[]:buildRecoveryIssues(catalog,context.reviews.filter(r=>!originalPricesOnly()||r.status!=='pending')).filter(issue=>!tracked.has(issue.productId))});return;
   }
   if(req.method==='GET'&&['/api/recovery-blockers/prices','/api/price-reviews/item'].includes(path)){
    const productId=id(requestUrl.searchParams.get('productId'),'商品ID'),view=displayContext();
    requireThat(!view.hiddenProductIds.includes(productId),'PRICE_REVIEW_CHANGED','该商品已排除或已下架，请刷新列表');
    const record=blockerView({filter:'all',query:productId,pageSize:20,includePriceOwned:true},view).records.find(r=>r.productId===productId);
    const latest=view.reviews.find(r=>r.productId===productId&&['pending','declined'].includes(r.status)&&r.createdAt<=Date.now());
    const selectedId=requestUrl.searchParams.get('reviewId'),selected=selectedId?journal.priceReview(selectedId):null;
    if(selectedId)requireThat(selected?.shopId===shopId&&selected.productId===productId&&['pending','approved','declined'].includes(selected.status)&&(!['pending','declined'].includes(selected.status)||selected.expiresAt>Date.now()),'PRICE_REVIEW_CHANGED','价格记录已变化或过期，请刷新列表');
    const assignment=view.ownership.byProduct.get(productId),dualDecision=view.dualDecisions.get(productId),paired=assignment?.reviewId?journal.priceReview(assignment.reviewId):null;
    const review=selectedId?selected:paired?.status==='pending'&&paired.expiresAt>Date.now()?paired:latest?.expiresAt>Date.now()?latest:journal.priceTarget(shopId,productId);
    const pendingPriceApproval=service.priceApprovalIntent?.(productId),hasPendingPriceApproval=pendingPriceApproval?.state==='pending';
    const approvalAllowed=!!(!selectedId&&!hasPendingPriceApproval&&view.dualEnabled&&dualPriceProposalReady(dualDecision)&&review?.status==='pending'&&review.expiresAt>Date.now()&&review.dualPairKey===dualDecision.pairKey&&dualDecision.schemes.some(s=>s.reviewId===review.id&&s.candidateReady!==false));
    const readOnly=!!review&&(review.status!=='pending'||!!selectedId||view.dualEnabled&&!approvalAllowed);
    requireThat(record||review||view.catalog.products.some(p=>p.productId===productId),'PRICE_REVIEW_CHANGED','商品不在本店可展示列表');
    const pending=view.tasks.some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===productId))||assignment?.carePending===true||hasPendingPriceApproval;
    const canRecalculate=!selectedId&&!pending&&!!latest&&['pending','declined'].includes(latest.status);
    const context={reviews:view.reviews,tasks:view.tasks,now:Date.now(),dualDecision};
    const excludedScheme=type=>!selectedId&&dualDecision?.schemes?.find(s=>s.type===type&&(s.scopeExcluded===true||s.candidateReady===false));
    const options=review?.status==='pending'&&!readOnly?blockerPriceOptions(review,context).map(option=>{const excluded=excludedScheme(option.activityType);return excluded?{...option,available:false,reason:excluded.reason,unavailableReason:excluded.reason}:option;}):[];
    const dualSchemes=workspaceSchemes(!selectedId?dualDecision:null),comparison=buildActivityPriceComparison({review,reviews:context.reviews,tasks:context.tasks,shopId,productId,options,schemes:record?.schemes||{},now:context.now}).map(item=>{const s=dualSchemes.find(s=>s.type===item.type);return{...item,classification:s.classification,evidenceAt:s.evidenceAt,...(!selectedId&&view.dualEnabled?{reason:s.reason}:{}),...(s.candidateReady===false?{candidateReady:false}:{}),...(s.scopeExcluded?{scopeExcluded:true,scopeExclusion:s.scopeExclusion}:{}),...(s.classification==='reduction-required'?{rejectionState:'rejected'}:{})};});
    const manualBasisKeys={};const manualTypes=review&&!readOnly&&manualPriceEditable(review)?['限时抢购','限量抢购'].filter(type=>{if(excludedScheme(type))return false;try{const basis=activityPriceBasis(review,type,context);manualBasisKeys[type]=basis.activityBasisKey||null;return true;}catch{return false;}}):[];
    const approvalBlockedReason=selectedId?'历史记录只读。':!view.dualEnabled?'请先启用双方案省心守护，让后台分别核验两种活动。':pending?assignment?.blockedReason||'后台正在处理或回读本商品。':dualDecision?.blockedReason||'尚未证明两种方案都必须降价，后台继续核验。';
    json(200,{shopId,productId,blocked:pending,blockedReason:hasPendingPriceApproval?'已收到确切价格确认，后台正在重新核验；不会再次要求确认同一组价格。':assignment?.blockedReason||null,...(hasPendingPriceApproval?{pendingPriceApproval:{id:pendingPriceApproval.intent.id,state:'pending'}}:{}),approvalAllowed,approvalBlockedReason:approvalAllowed?null:approvalBlockedReason,canRecalculate,readOnly,comparison,recheckReview:!selectedId&&latest?{id:latest.id,key:latest.key}:null,review:review?{...review,dualPairKey:dualDecision?.pairKey||review.dualPairKey||null,approvalAllowed,approvalBlockedReason:approvalAllowed?null:approvalBlockedReason,canRecalculate:canRecalculate&&review.id===latest?.id,options:review.status==='pending'&&!readOnly?options:undefined,activityComparison:comparison,manualTypes,manualBasisKeys,manualEditable:review.status==='pending'&&!readOnly&&manualPriceEditable(review)}:null});return;
   }
   if(req.method==='GET'&&path==='/api/recovery-blockers'){
    const q=requestUrl.searchParams,filter=['both','other','all'].includes(q.get('filter'))?q.get('filter'):'all';
    json(200,blockerView({filter,page:q.get('page')??0,pageSize:q.get('size')??10,query:q.get('q')||''}));return;
   }
   if(req.method==='GET'&&path==='/api/products'){
    const {catalog}=displayContext();
    json(200,catalog);return;
   }
   requireThat(req.method==='POST'&&req.headers.origin===origin&&req.headers['x-guardian-token']===token,'REQUEST_REJECTED','请求必须来自本机工作台');
   requireThat(req.headers['content-type']==='application/json','REQUEST_REJECTED','请求格式无效');
   const bodyLimit=path==='/api/migration/preview'?TRANSFER_MAX_BYTES+1024:['/api/price-reviews/decide','/api/price-reviews/preview','/api/recovery-blockers/prices/decide','/api/recovery-blockers/prices/preview'].includes(path)?2097152:4096;
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;requireThat(bytes<bodyLimit,'REQUEST_REJECTED','请求过大');chunks.push(chunk);}
   const body=Buffer.concat(chunks).toString('utf8');
   const args=JSON.parse(body||'{}');requireThat(args&&typeof args==='object'&&!Array.isArray(args),'REQUEST_REJECTED','请求内容无效');
   if(path==='/api/updates/check'){json(200,await checkForUpdates(version));return;}
   if(path==='/api/diagnostics/export'){
    requireThat(shopId&&args.shopId===shopId,'SHOP_MISMATCH','当前店铺已变化，请重新导出');
    requireThat(!exportingDiagnostics,'BUSY','诊断包正在导出');exportingDiagnostics=true;
    try{
     const catalog=buildCatalog({shopId,inventory:platform.inventory,observation:journal.settings('catalog-view:'+shopId),histories:journal.histories(shopId),tasks:journal.list(shopId),checks:journal.productChecks(shopId),excluded:policy.excludedProductIds||[]});
     json(200,await exportDiagnostics({root,runtime,journal,shopId,status:snapshot(),catalog,includeScreenshots:args.includeScreenshots===true}));
    }finally{exportingDiagnostics=false;}
    return;
   }
   if(path.startsWith('/api/migration/')){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId,'SHOP_MISMATCH','请先登录并连接备份对应的店铺');
    if(path==='/api/migration/preview'){
     const preview=validateTransfer(args.file,shopId);migrationPreview={id:randomBytes(24).toString('hex'),file:structuredClone(args.file),shopId,expiresAt:Date.now()+30*60000};
     json(200,{...preview,previewId:migrationPreview.id,expiresAt:migrationPreview.expiresAt});return;
    }
    requireThat(!service.running&&!service.busy&&!action,'BUSY','请等待守护暂停并完成当前动作后迁移');
    if(path==='/api/migration/export'){
     const file=makeTransfer(journal,accounts.selected(),{version});json(200,{file,name:`DoudianGuardian-${shopId}-${new Date().toISOString().slice(0,10)}.guardian-backup.json`});return;
    }
    if(path==='/api/migration/import'){
     requireThat(migrationPreview&&migrationPreview.shopId===shopId&&migrationPreview.id===args.previewId&&migrationPreview.expiresAt>Date.now(),'TRANSFER_PREVIEW','预览已失效，请重新选择备份');
     const result=importTransfer(journal,migrationPreview.file,{shopId,accepted:args.accepted,expectedDigest:args.digest});
     accounts.data=journal.settings('application');Object.assign(policy,accounts.selected());migrationPreview=null;
     json(200,{ok:true,...result});return;
    }
    throw Object.assign(new Error('没有此迁移操作'),{code:'NOT_FOUND'});
   }else if(path==='/api/dual-activity-care-policy'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    requireThat(!action,'BUSY','请等待当前店铺操作完成');
    requireThat(typeof args.enabled==='boolean'&&(!args.enabled||args.acceptBothActivityTypes===true&&args.acceptNonReducingRecovery===true),'DUAL_ACTIVITY_CONSENT_REQUIRED','请明确同意核验两种活动，只自动恢复不降价的方案。');
    if(args.enabled&&!policy.originalRiskAllowed)Object.assign(policy,accounts.authorizeOriginal(shopId));
    const setting=setDualActivityCarePolicy(journal,shopId,args);
    if(setting.enabled){
     if(!activeOriginalPriceRecoveryGrant(journal,shopId))setOriginalPriceRecoveryPolicy(journal,shopId,{enabled:true,acceptOriginalPricesOnly:true});
     if(!activeOriginalRebuildGrant(journal,shopId))setOriginalRebuildPolicy(journal,shopId,{enabled:true,acceptOriginalRebuild:true});
     setCareRecoveryPolicy(journal,shopId,{enabled:false});setPriceIncreasePolicy(journal,shopId,{enabled:false});
     const view=displayContext(),active=new Set(view.tasks.filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId))),histories=service.latestHistories();
     const ids=[...new Set([...view.checks.map(c=>c.productId),...view.reviews.filter(r=>['pending','declined'].includes(r.status)).map(r=>r.productId),...view.catalog.products.filter(p=>!p.current.length&&!p.scheduled.length).map(p=>p.productId)])].filter(productId=>!active.has(productId)&&!view.hiddenProductIds.includes(productId)&&histories.has(productId));
     for(const productId of ids)journal.clearProductCheck(shopId,productId);
     if(ids.length&&policy.liveEnabled&&policy.cutoverConfirmed)service.requestRecovery(ids,{reason:'dual-activity-care-enabled'});
    }
    json(200,{ok:true,enabled:setting.enabled,dualActivityCareEnabled:setting.enabled});return;
   }else if(path==='/api/care-recovery-policy'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    requireThat(!action,'BUSY','请等待当前店铺操作完成');
    requireThat(typeof args.enabled==='boolean'&&(!args.enabled||args.acceptNonReducingRecovery===true),'CARE_CONSENT_REQUIRED','请明确同意原价优先、全部规格不降价才自动调整，降价仍逐规格确认');
    if(args.enabled&&!policy.originalRiskAllowed)Object.assign(policy,accounts.authorizeOriginal(shopId));
    if(args.enabled&&activeDualActivityCareGrant(journal,shopId))setDualActivityCarePolicy(journal,shopId,{enabled:false});
    const setting=setCareRecoveryPolicy(journal,shopId,args);
    if(setting.enabled){
     if(!activeOriginalPriceRecoveryGrant(journal,shopId))setOriginalPriceRecoveryPolicy(journal,shopId,{enabled:true,acceptOriginalPricesOnly:true});
     if(!activeOriginalRebuildGrant(journal,shopId))setOriginalRebuildPolicy(journal,shopId,{enabled:true,acceptOriginalRebuild:true});
     setPriceIncreasePolicy(journal,shopId,{enabled:false});
     const active=new Set(journal.list(shopId).filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId)));
     // Last independently verified unavailable proofs also hide old proposals.
     // Apply this after merging checks/reviews, so a pending review cannot add
     // the same off-shelf product back into the wake/clear list.
     const hiddenInactive=new Set(displayContext().hiddenProductIds);
     const ids=[...new Set([...journal.productChecks(shopId).map(c=>c.productId),...journal.priceReviews(shopId).filter(r=>['pending','declined'].includes(r.status)).map(r=>r.productId)])].filter(productId=>!hiddenInactive.has(productId)&&!active.has(productId)&&!policy.excludedProductIds?.includes(productId)&&service.latestHistories().has(productId));
     for(const productId of ids)journal.clearProductCheck(shopId,productId);
     if(ids.length&&policy.liveEnabled&&policy.cutoverConfirmed)service.requestRecovery(ids,{reason:'care-recovery-enabled'});
    }
    json(200,{ok:true,enabled:setting.enabled,careRecoveryEnabled:setting.enabled});return;
   }else if(path==='/api/original-rebuild-policy'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    const setting=setOriginalRebuildPolicy(journal,shopId,args);if(!setting.enabled&&activeCareRecoveryGrant(journal,shopId))setCareRecoveryPolicy(journal,shopId,{enabled:false});if(!setting.enabled&&activeDualActivityCareGrant(journal,shopId))setDualActivityCarePolicy(journal,shopId,{enabled:false});
    if(setting.enabled){
     const ids=journal.productChecks(shopId).filter(c=>['LIMITED_LOSS_UNPROVEN','REBUILD_REVIEW_REQUIRED','TIMED_LOSS_UNPROVEN'].includes(c.code)&&!policy.excludedProductIds?.includes(c.productId)).map(c=>c.productId);
     for(const productId of ids)journal.clearProductCheck(shopId,productId);
     if(ids.length&&policy.liveEnabled&&policy.cutoverConfirmed)service.requestRecovery(ids,{reason:'shop-original-rebuild-enabled'});
    }
    json(200,{ok:true,enabled:setting.enabled});return;
   }else if(path==='/api/original-price-recovery-policy'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    const setting=setOriginalPriceRecoveryPolicy(journal,shopId,args);if(activeCareRecoveryGrant(journal,shopId))setCareRecoveryPolicy(journal,shopId,{enabled:false});if(activeDualActivityCareGrant(journal,shopId))setDualActivityCarePolicy(journal,shopId,{enabled:false});
    if(setting.enabled){
     setCareRecoveryPolicy(journal,shopId,{enabled:false});
     setPriceIncreasePolicy(journal,shopId,{enabled:false});
     if(!activeOriginalRebuildGrant(journal,shopId))setOriginalRebuildPolicy(journal,shopId,{enabled:true,acceptOriginalRebuild:true});
     const pending=new Set(journal.list(shopId).filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId)));
     const ids=journal.productChecks(shopId).filter(c=>!pending.has(c.productId)&&!policy.excludedProductIds?.includes(c.productId)&&service.latestHistories().has(c.productId)).map(c=>c.productId);
     if(ids.length&&policy.liveEnabled&&policy.cutoverConfirmed)service.requestRecovery(ids,{reason:'original-price-recovery-enabled'});
    }
    json(200,{ok:true,enabled:setting.enabled});return;
   }else if(path==='/api/price-increase-policy'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId,'SHOP_MISMATCH','请先连接并核对当前店铺');
    requireThat(!action,'BUSY','请等待当前店铺操作完成');
    requireThat(!args.enabled||!originalPricesOnly(),'ORIGINAL_PRICE_BLOCKED','请先关闭仅按原价恢复，再开启自动提价');
    const setting=setPriceIncreasePolicy(journal,shopId,{enabled:args.enabled,acceptHigherPricesAndRisk:args.acceptHigherPricesAndRisk});
    json(200,{ok:true,enabled:setting.enabled});return;
   }else if(path==='/api/price-reviews/cancel-confirmation'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    const productId=id(args.productId,'商品ID');json(200,{ok:true,...service.cancelExactPriceApproval(productId,args.intentId)});return;
   }else if(['/api/recovery-blockers/prices/decide','/api/recovery-blockers/prices/preview','/api/price-reviews/preview'].includes(path)||path==='/api/price-reviews/decide'&&args.acceptBlockedPriceChange===true){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'SHOP_MISMATCH','请先连接并核对当前店铺');
    requireThat(!action,'BUSY','请等待当前店铺操作完成');
    const review=journal.priceReview(args.reviewId),context=displayContext();
    requireThat(review?.shopId===shopId&&review.key===args.key&&!context.hiddenProductIds.includes(review.productId),'PRICE_REVIEW_CHANGED','商品或建议已变化，请刷新列表');
    const dualDecision=context.dualDecisions.get(review.productId);
    if(context.dualEnabled&&(path.endsWith('/preview')||args.decision==='approve'))requireThat((path.endsWith('/preview')?dualPriceApprovalReady(dualDecision):dualPriceProposalReady(dualDecision))&&args.dualPairKey===dualDecision.pairKey&&review.dualPairKey===dualDecision.pairKey&&dualDecision.schemes.some(s=>s.reviewId===review.id&&s.candidateReady!==false),'DUAL_ACTIVITY_RECHECK_REQUIRED','可用方案尚未证明必须降价，或核验已更新；请等待后台重新核验。');
    if(path.endsWith('/preview')){service.assertBlockedPriceReview(review);const basis=activityPriceBasis(review,args.activityType||review.type,{reviews:journal.priceReviews(shopId),tasks:journal.list(shopId),dualDecision});json(200,{ok:true,option:manualPriceOption(basis,args.discounts)});return;}
    requireThat(args.decision!=='approve'||args.acceptBlockedPriceChange===true,'PRICE_CONSENT_REQUIRED','须明确确认只调整本商品的确切价格');
    if(context.dualEnabled&&args.decision==='approve'){json(202,{ok:true,...service.queueExactPriceApproval({...args,approvalContext:'recovery-blockers'})});return;}
    const result=service.decidePriceReview({...args,approvalContext:'recovery-blockers'});json(200,{ok:true,review:result});return;
   }else if(path==='/api/price-reviews/decide'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId,'SHOP_MISMATCH','请先连接并核对当前店铺');
    requireThat(args.decision!=='approve'||!originalPricesOnly(),'ORIGINAL_PRICE_BLOCKED','本店只按原价恢复，新价格要求在恢复受阻查看；如需调价请先关闭该模式');
    const review=service.decidePriceReview({...args,approvalContext:null,manualDiscounts:null});json(200,{ok:true,review});return;
   }else if(path==='/api/recovery/request'){
    requireThat(shopId&&args.shopId===shopId&&connection?.shopId===shopId&&!authView().required,'LOGIN_REQUIRED','请先登录并核对当前店铺');
    const productId=id(args.productId,'商品ID');const result=service.requestRecovery([productId],{reason:'user-recheck'});json(202,{ok:true,...result});return;
   }else if(path==='/api/login'){
    const selected=accounts.selected(),reauthenticate=!!selected&&args.newAccount!==true&&(args.reauthenticate===true||authView().required);
    requireThat(!action&&!service.running&&!service.busy&&(!snapshot().unknown||reauthenticate),'BUSY','请等待当前工作停止；未知提交仅允许重新登录同一家店铺后回读');
    await background('打开店铺登录窗口',async()=>{
     await browser.close();connection=null;platform.stopping=false;
     loginExpectedShop=reauthenticate?selected.shopId:null;
     if(browser.openLogin){loginProfile=await browser.openLogin(reauthenticate?{shopId:selected.shopId,profileKey:selected.profileKey}:{});}
     else{loginProfile=selected?.profileKey||'shop-'+shopId;await browser.open(shopId,{login:true,profileKey:loginProfile});}
     const page=await browser.page();await page.goto(platform.base+LIST,{waitUntil:'domcontentloaded'});return'在专用窗口登录后，点击“登录完成”';
    });
   }else if(path==='/api/finish-login'){
    requireThat(!service.running,'BUSY','守护期间不能切换登录');
    if(shopId)wakeVerification(journal,shopId,journal.list(shopId).filter(t=>['unknown','verifying'].includes(t.phase)).map(t=>t.id));
    await background('识别店铺并同步当前折扣',async()=>{
     if(browser.loginMode){
      platform.stopping=false;const page=await browser.page();await page.goto(platform.base+LIST,{waitUntil:'domcontentloaded'});
      const identity=await (platform.identify?platform.identify(page):platform.identity(page));
      requireThat(!loginExpectedShop||identity.shopId===loginExpectedShop,'SHOP_MISMATCH','重新登录的店铺与原店铺不同；请切回原店铺，或使用添加店铺入口');
      await browser.close();bind(accounts.register(identity,loginProfile||'shop-'+identity.shopId));loginProfile=null;
      loginExpectedShop=null;
     }
     requireThat(shopId,'LOGIN_REQUIRED','请先登录店铺');
     if(platform.discover)await readCurrent();else acceptConnection(await platform.probe());
     const latestSettings=journal.settings(shopId)||{};
     if(latestSettings.autoStart===true&&policy.originalRiskAllowed===true&&policy.liveEnabled&&!platform.stopping)service.start();
     return connection;
    });
   }else if(path==='/api/accounts/select'){
    requireThat(!action&&!service.running&&!service.busy&&!snapshot().unknown,'BUSY','请先停止当前店铺守护并完成结果核实');
    const target=id(args.shopId);requireThat(accounts.list().some(a=>a.shopId===target),'ACCOUNT_UNKNOWN','尚未登录这家店铺');
    await background('切换店铺并同步折扣',async()=>{await browser.close();bind(accounts.select(target));return await readCurrent();});
   }else if(path==='/api/audit'){
    requireThat(shopId,'LOGIN_REQUIRED','请先登录店铺');requireThat(!service.running,'BUSY','后台已在自动同步');
    await background('同步当前折扣',readCurrent);
   }else if(path==='/api/preflight'){
    requireThat(shopId&&!service.running,'BUSY','请先登录并等待守护停止');
    await background('核对历史与当前规格',async()=>{await readCurrent();return await service.preview();});
   }else if(path==='/api/start'){
    requireThat(!action&&!service.busy,'BUSY','请等待当前检查完成');
    requireThat(shopId&&connection?.shopId===shopId,'LOGIN_REQUIRED','请先完成店铺登录识别');
    if(!policy.originalRiskAllowed){requireThat(args.originalDiscountConsent===true,'CONSENT_REQUIRED','请先确认按本店已记录的原折扣自动恢复');Object.assign(policy,accounts.authorizeOriginal(shopId));}
    saved.executionEnabled=true;saved.autoStart=true;journal.putSettings(shopId,saved);
    Object.assign(policy,{cutoverConfirmed:true,liveEnabled:true});platform.stopping=false;service.start();
   }else if(path==='/api/stop'){
    service.stop({pauseRequests:args.forUpgrade!==true});platform.stopping=true;if(shopId){saved.autoStart=false;journal.putSettings(shopId,saved);}
   }else if(path==='/api/shutdown'){
    const resumeIdle=args.resumeOnLaunch===true&&(saved.executionEnabled===true||saved.cutoverConfirmed===true)&&saved.autoStart===true;
    requireThat((!service.running||resumeIdle)&&!service.busy&&!action,'BUSY','后台空闲后才可维护退出');
    json(202,{ok:true,shuttingDown:true});setTimeout(()=>{void close();},20);return;
   }else throw Object.assign(new Error('没有此操作'),{code:'NOT_FOUND'});
   json(202,{ok:true,...snapshot()});
  }catch(e){json(e.code==='NOT_FOUND'?404:400,{ok:false,code:e.code||'BAD_REQUEST',message:e.message});}
 });
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{boundPort=server.address().port;accept();});});
 async function close(){if(closing)return;closing=true;service.stop();platform.stopping=true;
  while(service.busy||action)await new Promise(r=>setTimeout(r,100));await browser.close();await new Promise(r=>{server.close(r);server.closeIdleConnections();});journal.close();}
 // A desktop upgrade may have paused an older backend using its existing stop
 // API, which clears autoStart. Resume only an already authorized shop; this
 // flag never creates execution, original-discount or price-increase consent.
 const authorizedUpgradeResume=resumeOnUpgrade===true&&shopId&&policy.originalRiskAllowed===true&&
  (saved.executionEnabled===true||saved.cutoverConfirmed===true);
 if(authorizedUpgradeResume){saved.autoStart=true;journal.putSettings(shopId,saved);}
 if(shopId&&(saved.autoStart===true&&(saved.executionEnabled===true||saved.cutoverConfirmed===true))){
  await background('连接店铺',async()=>{platform.stopping=false;acceptConnection(await platform.probe());if(saved.autoStart===true&&!platform.stopping)service.start();return connection;});
 }else if(shopId&&!config&&!dependencies.platform&&!dependencies.service){await background('连接店铺并同步折扣',readCurrent);}
 const url='http://127.0.0.1:'+boundPort;
 await writeFile(join(runtime,'service-status.json'),JSON.stringify({pid:process.pid,url,shopId,startedAt:Date.now(),version,sourceRoot:root,sourceBuild},null,2),'utf8');
 return {server,url,close,snapshot};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flag=process.argv.indexOf('--shop');let config=null;
 if(flag>=0){const shop=id(process.argv[flag+1]);config=JSON.parse(await readFile(join(root,'config','shop-'+shop+'.json'),'utf8'));}
 const app=await createApp({config,runtime:process.env.GUARDIAN_RUNTIME||join(process.env.LOCALAPPDATA||root,'DoudianDiscountGuardianV2'),resumeOnUpgrade:process.env.GUARDIAN_UPGRADE_RESUME==='1'});
 console.log(JSON.stringify({ready:true,url:app.url,shopId:app.snapshot().shopId}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close();});
}
