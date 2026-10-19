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
import {AccountRegistry} from './accounts.mjs';
import {checkForUpdates,UPDATE_REPOSITORY} from './updates.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function createApp({config=null,rootDir=root,port=19417,runtime=join(rootDir,'runtime'),dependencies={}}={}){
 const buildHash=createHash('sha256');
 for(const file of (await readdir(join(root,'src'))).filter(n=>n.endsWith('.mjs')).sort())buildHash.update(file).update(await readFile(join(root,'src',file)));
 const sourceBuild=buildHash.digest('hex'),version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
 await mkdir(runtime,{recursive:true});
 const journal=dependencies.journal||new Journal(join(runtime,'guardian.sqlite')),accounts=new AccountRegistry(journal);
 if(config?.shopId)accounts.register(config,config.profileKey||'shop-'+id(config.shopId),{...config,captureExistingOnly:config.captureExistingOnly===true});
 const browser=dependencies.browser||new DedicatedBrowser(runtime),token=randomBytes(32).toString('hex'),instance=randomBytes(16).toString('hex');
 let shopId=null,policy={},saved={},platform,service,connection=null,action=null,lastAction=null,closing=false,loginProfile=null;
 function bind(account){
  shopId=account?.shopId||null;saved=shopId?journal.settings(shopId)||{}:{};
  const enabled=saved.executionEnabled===true||saved.cutoverConfirmed===true;
  policy={...account,shopId,liveEnabled:enabled,cutoverConfirmed:enabled};
  platform=dependencies.platformFactory?.(policy)||dependencies.platform||new DoudianPlatform({browser,policy,journal});
  service=dependencies.serviceFactory?.({policy,platform})||dependencies.service||new GuardianService({journal,platform,policy});
  connection=null;
 }
 bind(accounts.selected());
 const snapshot=()=>({version,build:'isolated-headless-journal',sourceBuild,instance,shopId,name:policy.name||null,connection,action,lastAction,
  ...service.status(),running:service.running,busy:service.busy,progress:platform.progress,excluded:policy.excludedProductIds||[],
  accounts:accounts.list(),originalRestoreAuthorized:policy.originalRiskAllowed===true,loginOpen:browser.loginMode===true,
  updates:{repository:UPDATE_REPOSITORY,currentVersion:version},
  events:shopId?journal.events(150).filter(e=>e.detail?.shopId===shopId||e.task&&journal.get(e.task)?.shopId===shopId).slice(0,30):[]});
 async function background(kind,fn){
  requireThat(!action&&!service.busy,'BUSY','当前任务完成前不能执行另一操作');action=kind;
  void(async()=>{try{const result=await fn();lastAction={kind,ok:true,at:Date.now(),result};}
   catch(e){lastAction={kind,ok:false,at:Date.now(),code:e.code||'ERROR',message:e.message};journal.event(null,'control-error',{shopId,...lastAction});}
   finally{action=null;}})();
 }
 async function readCurrent(){
  platform.stopping=false;connection=await platform.probe();const d=await platform.discover({historyReadLimit:0});
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
   const path=new URL(req.url,origin).pathname;
   if(req.method==='GET'&&path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
   const assets={'/app.js':['app.js','text/javascript; charset=utf-8'],'/app.css':['app.css','text/css; charset=utf-8'],'/guardian.png':['guardian.png','image/png']};
   if(req.method==='GET'&&assets[path]){const[file,type]=assets[path];res.writeHead(200,{'Content-Type':type});res.end(await readFile(join(rootDir,'public',file)));return;}
   if(req.method==='GET'&&path==='/api/status'){json(200,snapshot());return;}
   if(req.method==='GET'&&path==='/api/products'){
    const catalog=buildCatalog({shopId,inventory:platform.inventory,observation:shopId?journal.settings('catalog-view:'+shopId):null,
     histories:shopId?journal.histories(shopId):[],tasks:shopId?journal.list(shopId):[],excluded:policy.excludedProductIds||[]});
    const checks=shopId?journal.productChecks(shopId):[];
    for(const p of catalog.products){const c=checks.find(c=>c.productId===p.productId);if(c&&!p.current.length){p.check=c;p.reason=p.reason||c.message;}}
    json(200,catalog);return;
   }
   requireThat(req.method==='POST'&&req.headers.origin===origin&&req.headers['x-guardian-token']===token,'REQUEST_REJECTED','请求必须来自本机工作台');
   requireThat(req.headers['content-type']==='application/json','REQUEST_REJECTED','请求格式无效');
   let body='';for await(const chunk of req){body+=chunk.toString('utf8');requireThat(body.length<4096,'REQUEST_REJECTED','请求过大');}
   const args=JSON.parse(body||'{}');requireThat(args&&typeof args==='object'&&!Array.isArray(args),'REQUEST_REJECTED','请求内容无效');
   if(path==='/api/updates/check'){json(200,await checkForUpdates(version));return;}
   if(path==='/api/login'){
    requireThat(!action&&!service.running&&!service.busy&&!snapshot().unknown,'BUSY','请等待当前守护停止并核实未完成结果，再登录店铺');
    await background('打开店铺登录窗口',async()=>{
     await browser.close();connection=null;platform.stopping=false;
     if(browser.openLogin){loginProfile=await browser.openLogin();}else{loginProfile='shop-'+shopId;await browser.open(shopId,{login:true});}
     const page=await browser.page();await page.goto(platform.base+LIST,{waitUntil:'domcontentloaded'});return'在专用窗口登录后，点击“登录完成”';
    });
   }else if(path==='/api/finish-login'){
    requireThat(!service.running,'BUSY','守护期间不能切换登录');
    await background('识别店铺并同步当前折扣',async()=>{
     if(browser.loginMode){
      platform.stopping=false;const page=await browser.page();await page.goto(platform.base+LIST,{waitUntil:'domcontentloaded'});
      const identity=await (platform.identify?platform.identify(page):platform.identity(page));
      await browser.close();bind(accounts.register(identity,loginProfile||'shop-'+identity.shopId));loginProfile=null;
     }
     requireThat(shopId,'LOGIN_REQUIRED','请先登录店铺');
     if(platform.discover)await readCurrent();else connection=await platform.probe();return connection;
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
    service.stop();platform.stopping=true;if(shopId){saved.autoStart=false;journal.putSettings(shopId,saved);}
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
 if(shopId&&(saved.autoStart===true&&(saved.executionEnabled===true||saved.cutoverConfirmed===true))){
  await background('连接店铺',async()=>{platform.stopping=false;connection=await platform.probe();service.start();return connection;});
 }else if(shopId&&!config&&!dependencies.platform&&!dependencies.service){await background('连接店铺并同步折扣',readCurrent);}
 const url='http://127.0.0.1:'+boundPort;
 await writeFile(join(runtime,'service-status.json'),JSON.stringify({pid:process.pid,url,shopId,startedAt:Date.now(),version,sourceRoot:root,sourceBuild},null,2),'utf8');
 return {server,url,close,snapshot};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flag=process.argv.indexOf('--shop');let config=null;
 if(flag>=0){const shop=id(process.argv[flag+1]);config=JSON.parse(await readFile(join(root,'config','shop-'+shop+'.json'),'utf8'));}
 const app=await createApp({config,runtime:process.env.GUARDIAN_RUNTIME||join(process.env.LOCALAPPDATA||root,'DoudianDiscountGuardianV2')});
 console.log(JSON.stringify({ready:true,url:app.url,shopId:app.snapshot().shopId}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close();});
}
