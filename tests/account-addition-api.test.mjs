import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';
import {fingerprint} from '../src/policy.mjs';

async function fixture({existing=false,failSave=false,holdIdentity=false,failOldClose=false,loginPending=false,holdOldClose=false}={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-add-api-')),j=new Journal(':memory:');let starts=0,newContexts=0,oldProbes=0,settleIdentity,oldCloseBlocked=failOldClose,additionUrl='https://fxg.jinritemai.com/login/',releaseOld,oldCloseReleased=false;
 j.putSettings('900001',{executionEnabled:true,autoStart:false});j.putSettings('authentication:900001',{state:'required',lastVerifiedAt:1,expiredAt:Date.now()});
 const original={id:'a0000000-0000-4000-8000-000000000001',shop:'900001',phase:'unknown',body:JSON.stringify({title:'守护2-000000000000000000',plans:[{shopId:'900001',productId:'300001',name:'旧店未知商品',skus:[{id:'500001',name:'旧规格',baseFen:10000,discount:50,saleFen:5000}]}],createdAt:Date.now()-5000,submittedAt:Date.now()-4000,submitAttempts:1,riskAttempts:1,reason:'仅回读原提交'}),updated:Date.now()};
 j.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(original.id,original.shop,'old-unknown',original.phase,original.body,original.updated);
 const service={running:false,busy:false,status:()=>({tasks:[],unknown:1}),stop(){this.running=false;},start(){starts++;this.running=true;}};
 const mainBrowser={loginMode:false,sessionPersistence:{state:'saved',available:true,at:123},close:async()=>{if(oldCloseBlocked)throw Object.assign(Error('old close not confirmed'),{code:'BROWSER_CLOSE_UNCONFIRMED'});if(holdOldClose&&!oldCloseReleased)await new Promise(resolve=>{releaseOld=()=>{oldCloseReleased=true;resolve();};});}};
 const newIdentity=()=>{additionUrl='https://fxg.jinritemai.com/ffa/marketing/tools/limitsales';return{shopId:existing?'900001':'900002',name:existing?'旧店':'新店',observedAt:Date.now()};};
 const browserFactory=()=>{newContexts++;const b={context:null,sessionPersistence:null,openLogin:async args=>{b.context={};b.profileKey=args.profileKey;b.loginMode=true;return args.profileKey;},page:async()=>({goto:async()=>{},isClosed:()=>!b.context,url:()=>additionUrl}),checkpointSession:async()=>{b.sessionPersistence=failSave?{state:'unavailable',available:false,at:Date.now()}:{state:'saved',available:true,at:Date.now()};},close:async()=>{await b.checkpointSession();b.context=null;b.loginMode=false;}};return b;};
 const platformFactory=()=>({identify:async()=>{if(loginPending)throw Object.assign(Error('新店仍在等待扫码'),{code:'LOGIN_REQUIRED'});return holdIdentity?new Promise(resolve=>{settleIdentity=()=>resolve(newIdentity());}):newIdentity();},cancelReads(){}});
 const app=await createApp({port:0,runtime,config:{shopId:'900001',name:'旧店',profileKey:'signin-old-stable',originalRiskAllowed:true},dependencies:{journal:j,browser:mainBrowser,service,platform:{progress:{},base:'https://fxg.jinritemai.com',readHealth:()=>({active:[],quarantined:false}),probe:async()=>{oldProbes++;throw Object.assign(Error('old requires login'),{code:'LOGIN_REQUIRED'});}},accountAdditionBrowserFactory:browserFactory,accountAdditionPlatformFactory:platformFactory}});
 const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
 const post=async(path,args={})=>{const r=await fetch(app.url+'/api/'+path,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args)});return{status:r.status,data:await r.json()};};
 const idle=async()=>{while(app.snapshot().action)await new Promise(r=>setTimeout(r,3));};
 const oldState=()=>({selected:j.settings('application').selected,oldAccount:j.settings('application').accounts.find(a=>a.shopId==='900001'),unknown:j.db.prepare('SELECT * FROM tasks WHERE id=?').get(original.id),settings:j.settings('900001'),authentication:j.settings('authentication:900001'),persistence:mainBrowser.sessionPersistence});
 return{app,j,post,idle,service,oldState,counts:()=>({starts,newContexts,oldProbes}),settle:()=>settleIdentity?.(),hasHeldIdentity:()=>!!settleIdentity,hasHeldOldClose:()=>!!releaseOld,releaseOldClose:()=>releaseOld?.(),dispose:async()=>{settleIdentity?.();releaseOld?.();oldCloseBlocked=false;await app.close();await rm(runtime,{recursive:true,force:true});}};
}

test('register-only adds a new independent account while the old unknown row, selected account and authorization remain byte-identical',async()=>{
 const f=await fixture();try{
  const before=fingerprint(f.oldState());assert.equal((await f.post('login',{newAccount:true})).data.code,'BUSY');
  assert.equal((await f.post('login',{newAccount:true,registerOnly:true,background:true,expectedShopName:'新店'})).status,202);await f.idle();
  const state=f.app.snapshot();assert.equal(state.accountAddition.open,true);assert.equal(state.authentication.required,true);assert.equal(state.shopId,'900001');assert.equal(state.accountAddition.background,true);
  for(const path of ['start','audit','accounts/select','dual-activity-care-policy','price-reviews/decide','migration/export'])assert.equal((await f.post(path,{shopId:'900001',enabled:true})).data.code,'ACCOUNT_ADDITION_BUSY');
  assert.equal((await f.post('finish-login',{flowId:'stale-flow'})).data.code,'ACCOUNT_ADDITION_FLOW_CHANGED');
  assert.equal((await f.post('finish-login',{flowId:state.accountAddition.flowId})).status,202);await f.idle();assert.equal(f.app.snapshot().lastAction.ok,true,f.app.snapshot().lastAction.message);
  assert.equal(fingerprint(f.oldState()),before);assert.equal(f.app.snapshot().accounts.length,2);assert.equal(f.app.snapshot().shopId,'900001');assert.equal(f.counts().starts,0);assert.equal(f.counts().oldProbes,0);
  const added=f.j.settings('application').accounts.find(a=>a.shopId==='900002');assert.ok(added.profileKey.startsWith('signin-'));assert.notEqual(added.profileKey,'signin-old-stable');assert.equal(added.originalRiskAllowed,false);assert.equal(added.allowFurtherPriceReduction,false);assert.equal(f.j.settings('900002'),null);
  assert.equal((await f.post('accounts/select',{shopId:'900002'})).data.code,'BUSY');
  assert.equal((await f.post('finish-login',{flowId:state.accountAddition.flowId})).data.alreadyAdded,true);assert.equal(f.counts().oldProbes,0);
 }finally{await f.dispose();}
});
for(const mode of ['existing','failSave','failOldClose'])test('register-only '+mode+' never overwrites an old profile or adds an unverified account',async()=>{
 const f=await fixture({[mode]:true});try{
  const before=fingerprint(f.oldState());await f.post('login',{newAccount:true,registerOnly:true,background:true});await f.idle();
  if(f.app.snapshot().accountAddition.open){await f.post('finish-login',{flowId:f.app.snapshot().accountAddition.flowId});await f.idle();}
  assert.equal(f.app.snapshot().lastAction.ok,false);assert.equal(f.app.snapshot().accounts.length,1);assert.equal(fingerprint(f.oldState()),before);assert.equal(f.counts().starts,0);
 }finally{await f.dispose();}
});
test('cancel during new-account identity verification rejects the late identity and a stale finish cannot fall through to the old shop',async()=>{
 const f=await fixture({holdIdentity:true});try{
  const before=fingerprint(f.oldState());await f.post('login',{newAccount:true,registerOnly:true,background:true});await f.idle();const flowId=f.app.snapshot().accountAddition.flowId;
  await f.post('finish-login',{flowId});while(!f.hasHeldIdentity())await new Promise(r=>setTimeout(r,3));
  const cancel=f.post('accounts/addition/cancel',{flowId}),deadline=Date.now()+5000;while(f.app.snapshot().accountAddition.phase!=='cancelling'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,3));assert.equal(f.app.snapshot().accountAddition.phase,'cancelling');f.settle();assert.equal((await cancel).status,200);await f.idle();
  assert.equal(f.app.snapshot().accountAddition.open,false);assert.equal(f.app.snapshot().accounts.length,1);assert.equal(fingerprint(f.oldState()),before);
  assert.equal((await f.post('finish-login',{flowId})).data.code,'ACCOUNT_ADDITION_FLOW_CHANGED');assert.equal(f.counts().oldProbes,0);assert.equal(f.counts().starts,0);
 }finally{await f.dispose();}
});

test('new-account login pending cannot mark the selected old account expired or replace its session persistence',async()=>{
 const f=await fixture({loginPending:true});try{
  f.j.putSettings('authentication:900001',{state:'authenticated',lastVerifiedAt:Date.now()});const before=fingerprint(f.oldState());
  assert.equal(f.app.snapshot().authentication.required,false);await f.post('login',{newAccount:true,registerOnly:true,background:true});await f.idle();
  const flowId=f.app.snapshot().accountAddition.flowId;await f.post('finish-login',{flowId});await f.idle();
  assert.equal(f.app.snapshot().lastAction.ok,false);assert.equal(f.app.snapshot().lastAction.authenticationScope,'new-account');assert.equal(f.app.snapshot().authentication.required,false);
  assert.equal(fingerprint(f.oldState()),before);assert.equal(f.app.snapshot().accounts.length,1);
 }finally{await f.dispose();}
});

for(const action of ['stop','shutdown'])test(action+' during the old-browser close cannot launch a late independent login context',async()=>{
 const f=await fixture({holdOldClose:true});let capturedAtClose;
 try{
  const before=fingerprint(f.oldState().unknown),journalClose=f.j.close.bind(f.j);f.j.close=()=>{capturedAtClose=fingerprint(f.oldState().unknown);journalClose();};
  await f.post('login',{newAccount:true,registerOnly:true,background:true});while(!f.hasHeldOldClose())await new Promise(r=>setTimeout(r,3));
  if(action==='stop'){assert.equal((await f.post('stop')).status,202);f.releaseOldClose();await f.idle();assert.equal(fingerprint(f.oldState().unknown),before);}
  else{const closing=f.app.close();f.releaseOldClose();await closing;assert.equal(capturedAtClose,before);}
  assert.equal(f.counts().newContexts,0);assert.equal(f.counts().starts,0);
 }finally{f.releaseOldClose();await f.dispose();}
});
