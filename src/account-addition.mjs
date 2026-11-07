import {randomUUID} from 'node:crypto';
import {DedicatedBrowser} from './browser.mjs';
import {DoudianPlatform,PLATFORM,LIST} from './platform.mjs';
import {fingerprint,id,normalizeName,requireThat,GuardError} from './policy.mjs';

const publicAccount=account=>account?{shopId:account.shopId,name:account.name}:null;
const failureMessages={ACCOUNT_ALREADY_EXISTS:'这家店铺已经添加，原账号与登录资料保持不变',ACCOUNT_ADDITION_UNEXPECTED_SHOP:'登录店铺与本次要添加的店铺不同，未添加',ACCOUNT_REGISTRY_CHANGED:'原店铺列表或授权已变化，未添加新账号',ACCOUNT_IDENTITY:'新店铺身份尚未完整核实，未添加',LOGIN_REQUIRED:'请先完成本次新店铺登录'};
const safeError=error=>({code:String(error?.code||'ACCOUNT_ADDITION_FAILED').replace(/[^A-Z0-9_-]/g,'').slice(0,80)||'ACCOUNT_ADDITION_FAILED',
 message:/SESSION|PROFILE/.test(error?.code||'')?'新账号登录资料尚未安全保存，原店铺资料保留':/CLOSE/.test(error?.code||'')?'新账号登录窗口关闭尚未确认，原店铺资料保留':/CANCEL|STOPPED/.test(error?.code||'')?'本次添加已取消':failureMessages[error?.code]||'新账号尚未添加，请重新核对本次独立登录'});
function qrDescription(element){
 const visible=e=>!!e&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect=element.getBoundingClientRect();
 const fields=e=>[e.id,e.getAttribute('class'),e.getAttribute('alt'),e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-testid'),e.getAttribute('data-e2e')].filter(Boolean).join(' ');
 let marker=fields(element),parent=element.parentElement;for(let depth=0;parent&&depth<3&&!['BODY','HTML'].includes(parent.tagName);depth++,parent=parent.parentElement)marker+=' '+fields(parent);
 const semantic=/(?:qr[-_\s]?code|qrcode|二维码)/i.test(marker),square=rect.width>=64&&rect.height>=64&&rect.width<=600&&rect.height<=600&&Math.abs(rect.width-rect.height)<=Math.max(rect.width,rect.height)*0.08;
 const points=[[.2,.2],[.8,.2],[.5,.5],[.2,.8],[.8,.8]],uncovered=points.every(([x,y])=>{const top=document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y);return top===element||element.contains(top);});
 return{eligible:['IMG','CANVAS'].includes(element.tagName)&&visible(element)&&semantic&&square&&uncovered&&!element.querySelector('input,textarea,[contenteditable="true"]'),tag:element.tagName,width:rect.width,height:rect.height,
  semanticMarkers:[...new Set(marker.match(/qr[-_\s]?code|qrcode|二维码/ig)||[])].slice(0,8)};
}

// This controller owns a fresh login context only. It deliberately never calls
// bind, discover, readCurrent, submit, or any selected shop's service/browser.
export class AccountAddition {
 constructor({runtime,registry,browserFactory=root=>new DedicatedBrowser(root),platformFactory=options=>new DoudianPlatform(options),now=Date.now}={}){
  requireThat(typeof runtime==='string'&&runtime&&registry?.journal&&typeof registry.appendIndependent==='function','ACCOUNT_ADDITION_CONFIG','独立添加店铺配置不完整');
  this.runtime=runtime;this.registry=registry;this.browserFactory=browserFactory;this.platformFactory=platformFactory;this.now=now;
  this.phase='idle';this.flowId=null;this.generation=0;this.browser=null;this.platform=null;this.page=null;this.profileKey=null;this.operation=null;this.operationKind=null;this.startKey=null;this.lastError=null;this.added=null;this.background=true;
 }
 snapshot(){return{registerOnly:true,open:!!this.browser?.context||['opening','awaiting-login','verifying','cancelling','close-unconfirmed'].includes(this.phase),flowId:this.flowId,phase:this.phase,background:this.background,
  expectedShopId:this.expectedShopId||null,expectedShopName:this.expectedShopName||null,startedAt:this.startedAt||null,finishedAt:this.finishedAt||null,added:publicAccount(this.added),lastError:this.lastError};}
 _flow(flowId){requireThat(typeof flowId==='string'&&flowId===this.flowId,'ACCOUNT_ADDITION_FLOW_CHANGED','添加店铺页面已变化，请使用当前登录流程');}
 _check(generation,browser=this.browser){requireThat(generation===this.generation&&browser===this.browser&&!['cancelling','cancelled'].includes(this.phase),'ACCOUNT_ADDITION_CANCELLED','本次添加已取消，不保存晚到的登录结果');}
 _loginPage(generation,page=this.page){
  this._check(generation);requireThat(page===this.page&&this.browser?.context&&!page.isClosed(),'QR_UNAVAILABLE','本次专用登录页面不可用');
  let url;try{url=new URL(page.url());}catch{}
  requireThat(url?.origin===PLATFORM&&/^\/login(?:\/|$)/.test(url.pathname),'QR_UNAVAILABLE','只有本次官方登录页上的独立二维码可以显示');
 }
 _identityPage(generation,page=this.page,{completed=false}={}){
  this._check(generation);requireThat(page===this.page&&this.browser?.context&&!page.isClosed(),'ACCOUNT_IDENTITY','本次独立登录页面已关闭');let url;try{url=new URL(page.url());}catch{}
  requireThat(url?.origin===PLATFORM&&(!completed||!/^\/login(?:\/|$)/.test(url.pathname)),'ACCOUNT_IDENTITY','新店铺身份必须来自本次官方商家页面');
 }
 _track(kind,promise){this.operationKind=kind;this.operation=promise;promise.finally(()=>{if(this.operation===promise){this.operation=null;this.operationKind=null;}}).catch(()=>{});return promise;}
 async _closeOwned(browser){if(!browser)return;await browser.close();requireThat(!browser.context,'BROWSER_CLOSE_UNCONFIRMED','新账号登录窗口关闭尚未确认');}
 async _failed(error,generation,browser){
  if(error?.code==='BROWSER_CLOSE_UNCONFIRMED'&&browser?.context){if(browser===this.browser){this.phase='close-unconfirmed';this.lastError=safeError(error);}throw error;}
  let failure=error;try{await this._closeOwned(browser);}catch(closeError){failure=closeError;if(browser===this.browser){this.phase='close-unconfirmed';this.lastError=safeError(closeError);}throw closeError;}
  if(generation===this.generation){this.phase='error';this.lastError=safeError(failure);this.finishedAt=this.now();}
  const detail=safeError(failure);throw new GuardError(detail.code,detail.message);
 }
 start({background=true,expectedShopId=null,expectedShopName=null}={}){
  requireThat(typeof background==='boolean','ACCOUNT_ADDITION_CONFIG','登录显示方式无效');if(expectedShopId!==null)id(expectedShopId);
  if(expectedShopName!==null)requireThat(typeof expectedShopName==='string'&&normalizeName(expectedShopName).length>0&&normalizeName(expectedShopName).length<=200,'ACCOUNT_ADDITION_CONFIG','待添加店铺名称无效');
  const key=fingerprint({background,expectedShopId,expectedShopName:expectedShopName===null?null:normalizeName(expectedShopName)});
  if(this.operationKind==='start'&&this.operation){requireThat(key===this.startKey,'ACCOUNT_ADDITION_BUSY','另一次添加店铺正在打开');return this.operation;}
  requireThat(!this.snapshot().open&&!this.operation,'ACCOUNT_ADDITION_BUSY','请先完成或取消当前添加店铺流程');
  this.generation++;const generation=this.generation;this.flowId=randomUUID();this.profileKey='signin-'+randomUUID();this.background=background;this.expectedShopId=expectedShopId;this.expectedShopName=expectedShopName===null?null:normalizeName(expectedShopName);
  this.applicationKey=fingerprint(this.registry.journal.settings('application')||{selected:null,accounts:[]});this.startKey=key;this.startedAt=this.now();this.finishedAt=null;this.lastError=null;this.added=null;this.phase='opening';
  let browser=null;
  const operation=(async()=>{try{
   browser=this.browser=this.browserFactory(this.runtime);requireThat(browser&&typeof browser.openLogin==='function'&&typeof browser.close==='function'&&!browser.context,'ACCOUNT_ADDITION_CONFIG','独立登录浏览器必须是本次新建且尚未打开的上下文');
   this.platform=this.platformFactory({browser,policy:{shopId:null,liveEnabled:false,cutoverConfirmed:false},journal:null});this.page=null;
   const profile=await browser.openLogin({shopId:null,profileKey:this.profileKey,background});this._check(generation,browser);requireThat(profile===this.profileKey,'PROFILE_SCOPE','新账号登录目录与本次流程不一致');
   this.page=await browser.page();this._check(generation,browser);await this.page.goto(PLATFORM+LIST,{waitUntil:'domcontentloaded'});this._check(generation,browser);this.phase='awaiting-login';return this.snapshot();
  }catch(error){return this._failed(error,generation,browser);}})();return this._track('start',operation);
 }
 finish({flowId}={}){
  this._flow(flowId);if(this.operationKind==='finish'&&this.operation)return this.operation;
  if(this.phase==='added')return Promise.resolve({added:true,account:publicAccount(this.added),selectedUnchanged:true,flowId:this.flowId});
  requireThat(this.phase==='awaiting-login'&&this.browser?.context&&this.page&&!this.operation,'ACCOUNT_ADDITION_NOT_OPEN','请先打开本次独立登录流程');
  const generation=this.generation,browser=this.browser,page=this.page;this.phase='verifying';this.lastError=null;
  const operation=(async()=>{try{
   this._identityPage(generation,page);const identity=await this.platform.identify(page);this._check(generation,browser);this._identityPage(generation,page,{completed:true});id(identity?.shopId);requireThat(typeof identity.name==='string'&&normalizeName(identity.name),'ACCOUNT_IDENTITY','新店铺身份未完整核实');
   requireThat(Number.isSafeInteger(identity.observedAt)&&identity.observedAt>0&&identity.observedAt<=this.now()+5000&&this.now()-identity.observedAt<=120000,'ACCOUNT_IDENTITY','新店铺身份核实已过期');
   requireThat(!this.expectedShopId||identity.shopId===this.expectedShopId,'ACCOUNT_ADDITION_UNEXPECTED_SHOP','登录店铺与本次要添加的店铺不同，未添加');
   requireThat(!this.expectedShopName||normalizeName(identity.name)===this.expectedShopName,'ACCOUNT_ADDITION_UNEXPECTED_SHOP','登录店铺名称与本次要添加的店铺不同，未添加');
   const current=this.registry.journal.settings('application')||{selected:null,accounts:[]};requireThat(!current.accounts.some(a=>a.shopId===identity.shopId),'ACCOUNT_ALREADY_EXISTS','这家店铺已经添加，原账号与登录资料保持不变');
   const checkpointAt=this.now();await browser.checkpointSession();this._check(generation,browser);this._identityPage(generation,page,{completed:true});requireThat(browser.sessionPersistence?.state==='saved'&&browser.sessionPersistence.available===true&&browser.sessionPersistence.at>=checkpointAt,'ACCOUNT_SESSION_NOT_SAVED','新账号登录资料尚未安全保存，暂不添加');
   const closeAt=this.now();await this._closeOwned(browser);this._check(generation,browser);requireThat(browser.sessionPersistence?.state==='saved'&&browser.sessionPersistence.available===true&&browser.sessionPersistence.at>=closeAt,'ACCOUNT_SESSION_NOT_SAVED','关闭时的新账号登录资料未安全保存，暂不添加');
   // No await is allowed between this generation check and the atomic append.
   this._check(generation,browser);const account=this.registry.appendIndependent(identity,this.profileKey,{expectedApplicationKey:this.applicationKey});this.added=account;this.phase='added';this.finishedAt=this.now();this.page=null;
   return{added:true,account:publicAccount(account),selectedUnchanged:true,flowId:this.flowId};
  }catch(error){
   if(error?.code==='LOGIN_REQUIRED'&&generation===this.generation&&browser?.context){
    let stillOfficial=false;try{this._loginPage(generation,page);stillOfficial=true;}catch{}
    if(stillOfficial){this.phase='awaiting-login';this.lastError=safeError(error);throw new GuardError('LOGIN_REQUIRED',this.lastError.message);}
   }
   return this._failed(error,generation,browser);
  }})();return this._track('finish',operation);
 }
 cancel({flowId}={}){
  this._flow(flowId);if(this.phase==='added')return Promise.resolve({...this.snapshot(),alreadyAdded:true,cancelled:false,message:'新店铺已登记，本次取消不会撤销已完成的登记；当前守护店铺保持不变'});
  if(this.phase==='cancelled')return Promise.resolve(this.snapshot());if(this.cancelOperation)return this.cancelOperation;
  const browser=this.browser,pending=this.operation;this.generation++;const generation=this.generation;this.phase='cancelling';if(this.platform){this.platform.stopping=true;this.platform.cancelReads?.();}
  const operation=(async()=>{
   if(pending)await pending.catch(()=>{});
   requireThat(this.generation===generation&&this.flowId===flowId,'ACCOUNT_ADDITION_FLOW_CHANGED','取消登录流程已经变化');
   try{await this._closeOwned(browser);}catch(error){this.phase='close-unconfirmed';this.lastError=safeError(error);throw error;}
   requireThat(this.generation===generation&&this.flowId===flowId,'ACCOUNT_ADDITION_FLOW_CHANGED','取消登录流程已经变化');
   this.phase='cancelled';this.page=null;this.finishedAt=this.now();return this.snapshot();
  })();this.cancelOperation=operation;operation.finally(()=>{if(this.cancelOperation===operation)this.cancelOperation=null;}).catch(()=>{});return operation;
 }
 async readLoginView({flowId}={}){
  this._flow(flowId);requireThat(this.phase==='awaiting-login'&&!this.operation,'QR_UNAVAILABLE','本次登录页面暂不可用');const generation=this.generation,page=this.page;this._loginPage(generation,page);
  const methods=await page.locator('button,[role="button"],a,label').evaluateAll(elements=>elements.filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(e=>(e.innerText||'').trim()).filter(value=>/^(?:扫码登录|二维码登录|手机号登录|手机验证码登录|验证码登录|账号密码登录|密码登录|抖音扫码登录|短信登录)$/.test(value)));this._loginPage(generation,page);
  const controls=page.locator('img,canvas'),count=await controls.count();this._loginPage(generation,page);requireThat(count<=50,'QR_UNAVAILABLE','登录二维码控件数量超出安全核对范围');const qrCandidates=[];
  for(let index=0;index<count;index++){const value=await controls.nth(index).evaluate(qrDescription);this._loginPage(generation,page);qrCandidates.push(value);}
  return{flowId:this.flowId,methods:[...new Set(methods)],qrCandidates,at:this.now(),scope:'visible login method labels and QR element structure only'};
 }
 async loginQr({flowId}={}){
  this._flow(flowId);try{
  requireThat(this.phase==='awaiting-login'&&!this.operation,'QR_UNAVAILABLE','本次登录二维码暂不可用');const generation=this.generation,page=this.page;this._loginPage(generation,page);
  const controls=page.locator('img,canvas'),count=await controls.count();this._loginPage(generation,page);requireThat(count<=50,'QR_UNAVAILABLE','登录二维码控件无法唯一核实');const candidates=[];
  for(let index=0;index<count;index++){const control=controls.nth(index),description=await control.evaluate(qrDescription);this._loginPage(generation,page);if(description.eligible)candidates.push(control);}
  requireThat(candidates.length===1,'QR_UNAVAILABLE','没有唯一可见的登录二维码，未截取登录页面');
  const handle=await candidates[0].elementHandle();this._loginPage(generation,page);requireThat(handle,'QR_UNAVAILABLE','登录二维码已经变化');
  try{
   const before=await handle.evaluate(qrDescription);this._loginPage(generation,page);requireThat(before.eligible,'QR_UNAVAILABLE','登录二维码被遮挡或已经变化');
   const bytes=await handle.screenshot({type:'png',timeout:5000});this._loginPage(generation,page);const after=await handle.evaluate(qrDescription);this._loginPage(generation,page);
   requireThat(after.eligible&&Buffer.isBuffer(bytes)&&bytes.length>8&&bytes.length<=1024*1024,'QR_UNAVAILABLE','登录二维码未能安全读取');return{flowId:this.flowId,mimeType:'image/png',imageBase64:bytes.toString('base64'),at:this.now()};
  }finally{await handle.dispose?.();this._loginPage(generation,page);}
  }catch(error){if(['ACCOUNT_ADDITION_CANCELLED','ACCOUNT_ADDITION_FLOW_CHANGED'].includes(error?.code))throw error;throw new GuardError('QR_UNAVAILABLE','本次登录二维码暂未能安全读取，未截取账号或密码页面');}
 }
}
