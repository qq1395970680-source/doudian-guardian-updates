import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {GuardError,requireThat} from './policy.mjs';
import {accountSlice} from './platform-snapshot.mjs';

const scope=new AsyncLocalStorage(),rawObjects=new WeakMap();
export const currentReadOperation=()=>scope.getStore();
export const rawReadObject=value=>rawObjects.get(value)||value;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function bounded(promise,ms,error){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error),ms);})]);}
 finally{clearTimeout(timer);}
}
const unwrap=value=>{
 if(!value||typeof value!=='object')return value;
 if(rawObjects.has(value))return rawObjects.get(value);
 if(Array.isArray(value))return value.map(unwrap);
 return Object.getPrototypeOf(value)===Object.prototype?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unwrap(v)])):value;
};
// Each operation owns its pages and all awaited browser calls. A deadline alone
// is insufficient: close and confirm cancellation before permitting another read
// or write, and reject late results before they can become inventory evidence.
class ReadOperation {
 constructor(manager,meta){
  this.manager=manager;this.meta=meta;this.id=randomUUID();this.startedAt=Date.now();this.deadline=this.startedAt+(meta.budgetMs||manager.budgetMs);
  this.lastStep='start';this.lastProgressAt=this.startedAt;this.pages=new Set();this.pendingPages=new Set();this.proxies=new WeakMap();this.error=null;this.cleanupState='not-needed';
  this.cancelled=new Promise((_,reject)=>{this.reject=reject;});this.cancelled.catch(()=>{});
 }
 status(){return{operationId:this.id,...this.meta,startedAt:this.startedAt,deadline:this.deadline,lastStep:this.lastStep,lastProgressAt:this.lastProgressAt,
  ageMs:Date.now()-this.lastProgressAt,pageCount:this.pages.size,cancelled:!!this.error,cleanupState:this.cleanupState};}
 check(){if(this.error)throw this.error;requireThat(!this.manager.quarantined,'READ_CLEANUP_BLOCKED','专用浏览器清理尚未确认，暂停新操作');}
 abort(error){if(!this.error){this.error=error;this.reject(error);}}
 timeout(step){return new GuardError('READ_OPERATION_TIMEOUT',`只读操作超时：${this.meta.kind} / ${step}`,{readOperation:this.status()});}
 async call(work,step){
  this.check();this.lastStep=step;
  try{
   const result=await bounded(Promise.race([Promise.resolve().then(work),this.cancelled]),Math.max(1,Math.min(this.manager.stepMs,this.deadline-Date.now())),this.timeout(step));
   this.check();this.lastProgressAt=Date.now();return result;
  }catch(error){if(error.code==='READ_OPERATION_TIMEOUT')this.abort(error);throw this.error||error;}
 }
 async newPage(create){
  const pending=Promise.resolve().then(create);this.pendingPages.add(pending);
  pending.then(page=>{this.pages.add(page);this.pendingPages.delete(pending);},()=>this.pendingPages.delete(pending));
  return this.page(await this.call(()=>pending,'newPage'));
 }
 page(page){const raw=rawReadObject(page);this.pages.add(raw);return this.wrap(raw,'page');}
 wrap(value,label){
  if(!value||typeof value!=='object')return value;
  if(this.proxies.has(value))return this.proxies.get(value);
  const wrappedKinds=['Page','Locator','Keyboard','Mouse','Touchscreen','Download','JSHandle','ElementHandle'];
  if(label!=='page'&&!wrappedKinds.includes(value.constructor?.name))return value;
  const op=this,proxy=new Proxy(value,{get(target,key){
   const item=Reflect.get(target,key,target);
   if(typeof item!=='function')return op.wrap(item,String(key));
   return(...args)=>{
    // Playwright's local locator construction and sync accessors must stay sync.
    op.check();const result=item.apply(target,args.map(unwrap));
    if(result&&typeof result.then==='function')return op.call(()=>result,label+'.'+String(key)).then(v=>op.wrap(v,String(key)));
    return op.wrap(result,String(key));
   };
  }});
  this.proxies.set(value,proxy);rawObjects.set(proxy,value);return proxy;
 }
 async pollLogin(){
  if(this.polling||this.error)return;this.polling=true;
  try{for(const page of this.pages){
   if(page.isClosed())continue;
   const a=await bounded(page.evaluate(accountSlice),Math.min(1500,this.manager.stepMs),this.timeout('login-check'));
   if(a.login){this.abort(new GuardError('LOGIN_REQUIRED','专用浏览器登录已失效，请重新登录',{readOperation:this.status()}));break;}
  }}catch{}finally{this.polling=false;}
 }
 async cleanup(){
  this.cleanupState='closing-pages';
  const closed=await Promise.all([...this.pages].map(async page=>{
   try{if(!page.isClosed())await bounded(page.close({runBeforeUnload:false}),this.manager.cleanupMs,this.timeout('page-close'));return page.isClosed();}catch{return false;}
  }));
  // Page creation may settle while existing pages are closing. Recheck the
  // current set, not only the array captured before awaiting those closes.
  if(closed.every(Boolean)&&!this.pendingPages.size&&[...this.pages].every(page=>page.isClosed())){this.cleanupState='confirmed';return;}
  this.cleanupState='isolating-context';this.manager.cancel('READ_CONTEXT_CANCELLED','同一专用浏览器的读取清理中');
  let isolated=false;
  try{isolated=await this.manager.isolateContext();}catch{}
  if(isolated){this.cleanupState='context-closed';return;}
  this.cleanupState='blocked';this.manager.quarantined=true;
  throw new GuardError('READ_CLEANUP_BLOCKED','只读操作已中止，但浏览器关闭未确认；保留占用，禁止启动另一实例或提交活动',{readOperation:this.status()});
 }
}
export class ReadOperations {
 constructor({budgetMs=300000,stepMs=45000,cleanupMs=5000,pollMs=750,isolate,onEvent=()=>{}}={}){
  Object.assign(this,{budgetMs,stepMs,cleanupMs,pollMs,isolate,onEvent});this.active=new Map();this.last=null;this.quarantined=false;this.isolation=null;
 }
 snapshot(){return{quarantined:this.quarantined,active:[...this.active.values()].map(v=>v.status()),last:this.last};}
 cancel(code='STOPPED',message='只读操作已停止'){for(const op of this.active.values())op.abort(new GuardError(code,message,{readOperation:op.status()}));}
 isolateContext(){
  // Concurrent readers can all be waiting for newPage() when Stop arrives.
  // They must share the same close acknowledgement. A second close against an
  // already-closed context is not evidence that cleanup failed.
  if(!this.isolation)this.isolation=bounded(Promise.resolve().then(()=>this.isolate?.()),this.cleanupMs,
   new GuardError('READ_CLEANUP_BLOCKED','专用浏览器关闭未确认')).then(value=>value===true,()=>false);
  return this.isolation;
 }
 async run(meta,fn){
  requireThat(!this.quarantined,'READ_CLEANUP_BLOCKED','专用浏览器清理未确认，请先完成安全维护');
  requireThat(!this.isolation,'READ_CONTEXT_CANCELLED','专用浏览器正在关闭，请等待同轮只读操作结束');
  const parent=currentReadOperation();
  if(parent?.manager===this){parent.check();parent.lastStep=meta.kind;const value=await fn(parent);parent.check();return value;}
  const op=new ReadOperation(this,meta);this.active.set(op.id,op);this.onEvent('read-operation-started',op.status());
  const timer=setTimeout(()=>op.abort(op.timeout(op.lastStep)),Math.max(1,op.deadline-Date.now()));
  const poll=this.pollMs?setInterval(()=>void op.pollLogin(),this.pollMs):null;
  try{
   const value=await Promise.race([scope.run(op,()=>fn(op)),op.cancelled]);op.check();this.last={...op.status(),finishedAt:Date.now(),ok:true};return value;
  }catch(error){
   op.abort(error);clearInterval(poll);clearTimeout(timer);
   if(error.code==='LOGIN_REQUIRED')this.cancel('LOGIN_REQUIRED','专用浏览器登录失效，取消同轮只读操作');
   try{await op.cleanup();}catch(cleanupError){error=cleanupError;}
   this.last={...op.status(),finishedAt:Date.now(),ok:false,code:error.code||'READ_ERROR',message:String(error.message).slice(0,1000)};
   await this.onEvent('read-operation-failed',this.last);throw error;
  }finally{
   clearInterval(poll);clearTimeout(timer);this.active.delete(op.id);if(!this.active.size&&!this.quarantined)this.isolation=null;
   if(this.last?.operationId===op.id&&this.last.ok)this.onEvent('read-operation-finished',this.last);
  }
 }
}
