import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {AccountAddition} from '../../src/account-addition.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {PLATFORM,LIST} from '../../src/platform.mjs';
import {loadProfileSession} from '../../src/profile-session.mjs';
import {fingerprint} from '../../src/policy.mjs';

const oldShop='900001',newShop='900002',newName='合成新增测试店铺',syntheticCookie='synthetic-account-addition-value-only';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function unchangedTables(journal){return journal.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:journal.db.prepare('SELECT * FROM '+name).all().filter(row=>!(name==='settings'&&row.shop==='application'))}));}
async function sourceHashes(){return Promise.all(['src/account-addition.mjs','src/accounts.mjs','src/browser.mjs','src/platform.mjs','src/login-state.mjs','src/platform-snapshot.mjs','src/profile-session.mjs','tests/browser/account-addition-native.test.mjs'].map(async path=>({path,sha256:hash(await readFile(resolve(path)))})));}
const loginHtml=count=>`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:20px;background:#fff;font:16px sans-serif}.qr-login{display:inline-block;margin-right:20px}canvas{display:block;width:180px;height:180px}.credentials{position:absolute;left:730px;top:60px;width:250px}input{display:block;margin:15px;padding:8px}</style><h1>合成扫码登录测试</h1><button>扫码登录</button><button>密码登录</button>${Array.from({length:count},(_,i)=>'<section class="qr-login"><canvas id="login-qrcode-'+i+'" width="180" height="180" aria-label="合成登录二维码"></canvas></section>').join('')}<section class="credentials"><input placeholder="手机号" value="synthetic-phone-never-read"><input type="password" placeholder="密码" value="synthetic-password-never-read"><button>登录</button></section><script>if(location.pathname!=='/login/common')history.replaceState(null,'','/login/common');for(const canvas of document.querySelectorAll('canvas')){const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,180,180);ctx.fillStyle='#000';for(let y=0;y<20;y++)for(let x=0;x<20;x++)if((x+y)%2===0)ctx.fillRect(10+x*8,10+y*8,8,8);}</script>`;
const identityHtml=`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><h1>合成商家页面</h1><div class="index_shopTitle__synthetic"><span class="index_userName__synthetic" title="${newName}">${newName}</span><div label="店铺ID" value="${newShop}"><span class="index_descValueText__synthetic">${newShop}</span></div></div>`;
async function fixture(qrCount=1){
 const dir=await mkdtemp(join(tmpdir(),'guardian-account-addition-native-')),journal=new Journal(join(dir,'guardian.sqlite')),registry=new AccountRegistry(journal);
 registry.register({shopId:oldShop,name:'合成原店铺'},'signin-original');registry.authorizeOriginal(oldShop);journal.putSettings(oldShop,{autoStart:true,executionEnabled:true});
 journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('synthetic-old-unknown',oldShop,'synthetic-old-dedupe','unknown',JSON.stringify({submitAttempts:1,riskAttempts:1,plans:[{productId:'300001'}]}),1000);
 const oldProfile=join(dir,'profiles','signin-original');await mkdir(oldProfile,{recursive:true});const sentinel=join(oldProfile,'synthetic-sentinel.txt');await writeFile(sentinel,'synthetic original profile must remain unchanged','utf8');
 const originalProfileHash=hash(await readFile(sentinel)),originalApp=journal.settings('application'),otherRows=fingerprint(unchangedTables(journal)),traffic={observed:0,intercepted:0,fulfilled:0,aborted:0,continued:0,foreignAttempts:0,methods:[],paths:[]},state={authenticated:false,wholePageCaptureAttempts:0,openArgs:[],newProfile:null};let browser;
 const addition=new AccountAddition({runtime:dir,registry,browserFactory:runtime=>{
  browser=new DedicatedBrowser(runtime,{test:true,viewport:{width:1000,height:720}});const originalOpen=browser.openLogin.bind(browser);
  browser.openLogin=async args=>{
   state.openArgs.push({...args});assert.equal(args.background,true);const result=await originalOpen(args);state.newProfile=browser.profilePath;browser.context.on('request',()=>traffic.observed++);
   // Last registered route wins. Every official URL below is served from a
   // local string; no request is continued to the real platform or elsewhere.
   await browser.context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());traffic.intercepted++;traffic.methods.push(request.method());traffic.paths.push(url.pathname);
    if(url.origin!==PLATFORM){traffic.foreignAttempts++;traffic.aborted++;return route.abort();}
    if(url.pathname===LIST){traffic.fulfilled++;return state.authenticated?route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:identityHtml}):route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:loginHtml(qrCount)});}
    if(url.pathname==='/login/common'){traffic.fulfilled++;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:loginHtml(qrCount)});}
    if(url.pathname==='/favicon.ico'){traffic.fulfilled++;return route.fulfill({status:204,body:''});}
    traffic.aborted++;return route.abort();
   });return result;
  };return browser;
 }});
 return{dir,journal,registry,addition,state,traffic,get browser(){return browser;},async assertOriginal(){assert.equal(journal.settings('application').selected,oldShop);assert.deepEqual(journal.settings('application').accounts[0],originalApp.accounts[0]);assert.equal(fingerprint(unchangedTables(journal)),otherRows);assert.equal(hash(await readFile(sentinel)),originalProfileHash);},async close(){
  if(addition.snapshot().open&&addition.snapshot().flowId)await addition.cancel({flowId:addition.snapshot().flowId}).catch(()=>{});if(browser?.context)await browser.close();journal.close();
  const inside=relative(resolve(tmpdir()),resolve(dir));assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside)&&basename(dir).startsWith('guardian-account-addition-native-'));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }};
}

test('native headless account addition crops synthetic QR, retains unfinished flow and saves a fresh vault before unselected registration',{timeout:90000},async()=>{
 const f=await fixture();try{
  const start=await f.addition.start({background:true,expectedShopId:newShop,expectedShopName:newName});assert.equal(start.open,true);assert.equal(start.phase,'awaiting-login');assert.equal(f.browser.loginMode,true);assert.ok(f.state.newProfile.endsWith(f.browser.profilePath.split(/[\\/]/).at(-1)));assert.notEqual(basename(f.state.newProfile),'signin-original');
  // A whole-page screenshot is forbidden even though synthetic credential
  // inputs deliberately exist outside the QR control in this fixture.
  const page=f.addition.page;page.screenshot=async()=>{f.state.wholePageCaptureAttempts++;throw Error('whole-page login capture forbidden');};
  const view=await f.addition.readLoginView({flowId:start.flowId});assert.equal(view.qrCandidates.filter(q=>q.eligible).length,1,JSON.stringify({view,traffic:f.traffic,markup:(await page.content()).slice(0,180)}));assert.ok(!JSON.stringify(view).includes('synthetic-password-never-read'));
  const qr=await f.addition.loginQr({flowId:start.flowId}),pixels=Buffer.from(qr.imageBase64,'base64');const pixelWidth=pixels.readUInt32BE(16),pixelHeight=pixels.readUInt32BE(20);assert.ok(pixelWidth>=180&&pixelWidth<=181);assert.ok(pixelHeight>=180&&pixelHeight<=181);assert.equal(f.state.wholePageCaptureAttempts,0);
  const qrBox=await page.locator('canvas').boundingBox(),inputBoxes=await page.locator('input').evaluateAll(nodes=>nodes.map(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};}));assert.ok(inputBoxes.every(b=>b.x>=qrBox.x+qrBox.width));
  const context=f.browser.context;await assert.rejects(f.addition.finish({flowId:start.flowId}),e=>e.code==='LOGIN_REQUIRED');assert.equal(f.addition.snapshot().phase,'awaiting-login');assert.equal(f.browser.context,context);assert.equal(f.registry.list().length,1);await f.assertOriginal();
  f.state.authenticated=true;await context.addCookies([{name:'synthetic-account-addition',value:syntheticCookie,domain:'fxg.jinritemai.com',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);await page.goto(PLATFORM+LIST,{waitUntil:'domcontentloaded'});
  const result=await f.addition.finish({flowId:start.flowId});assert.equal(result.added,true);assert.equal(result.account.shopId,newShop);assert.equal(f.addition.snapshot().open,false);assert.equal(f.browser.context,null);assert.equal(f.browser.sessionPersistence.state,'saved');await f.assertOriginal();
  const added=f.journal.settings('application').accounts[1];assert.equal(added.shopId,newShop);assert.equal(added.originalRiskAllowed,false);assert.equal(added.allowFurtherPriceReduction,false);assert.equal(added.executionEnabled,false);assert.equal(added.cutoverConfirmed,false);assert.equal(f.journal.settings(newShop),null);
  const encrypted=await readFile(join(f.state.newProfile,'guardian-session.v1.dpapi'));assert.equal(encrypted.includes(Buffer.from(syntheticCookie)),false);const saved=await loadProfileSession(f.state.newProfile);assert.equal(saved.length,1);assert.equal(saved.find(c=>c.name==='synthetic-account-addition')?.value,syntheticCookie);
  assert.equal(f.traffic.continued,0);assert.equal(f.traffic.foreignAttempts,0);assert.ok(f.traffic.methods.every(m=>m==='GET'));assert.equal(f.traffic.intercepted,f.traffic.fulfilled+f.traffic.aborted);assert.equal(f.traffic.observed,f.traffic.intercepted);
  await mkdir(resolve('artifacts/account-addition-native'),{recursive:true});await writeFile(resolve('artifacts/account-addition-native/unique-synthetic-qr.png'),pixels);
  await writeFile(resolve('artifacts/account-addition-native/registration-proof.json'),JSON.stringify({at:Date.now(),syntheticOnly:true,actualShopLogin:false,realChromium:true,backgroundHeadless:true,realSourceIdentity:true,realDpapiCheckpointAndClose:true,newAccountAppendedUnselected:true,oldUnknownAndOtherJournalRowsUnchanged:true,oldProfileUnchanged:true,newAuthorityGranted:false,unfinishedLoginFlowRetained:true,qrCrop:{width:pixelWidth,height:pixelHeight,controlWidth:180,controlHeight:180,maximumSubpixelRoundingPixels:1,credentialInputsOutsideCrop:true,wholePageCaptureAttempts:0},network:{...f.traffic,externalRequestsSent:0},sourceFiles:await sourceHashes()},null,2),'utf8');
 }finally{await f.close();}
});

test('native login with two synthetic QR controls refuses capture and cancels without account or authority changes',{timeout:60000},async()=>{
 const f=await fixture(2);try{
  const start=await f.addition.start({background:true,expectedShopName:newName}),page=f.addition.page;page.screenshot=async()=>{f.state.wholePageCaptureAttempts++;throw Error('whole-page capture forbidden');};
  const view=await f.addition.readLoginView({flowId:start.flowId});assert.equal(view.qrCandidates.filter(q=>q.eligible).length,2,JSON.stringify({view,traffic:f.traffic,markup:(await page.content()).slice(0,180)}));await assert.rejects(f.addition.loginQr({flowId:start.flowId}),e=>e.code==='QR_UNAVAILABLE');assert.equal(f.state.wholePageCaptureAttempts,0);await f.addition.cancel({flowId:start.flowId});assert.equal(f.addition.snapshot().open,false);assert.equal(f.browser.context,null);assert.equal(f.registry.list().length,1);await f.assertOriginal();assert.equal(f.traffic.continued,0);assert.equal(f.traffic.foreignAttempts,0);assert.equal(f.traffic.observed,f.traffic.intercepted);
  await mkdir(resolve('artifacts/account-addition-native'),{recursive:true});await writeFile(resolve('artifacts/account-addition-native/ambiguous-qr-proof.json'),JSON.stringify({at:Date.now(),syntheticOnly:true,actualShopLogin:false,realChromium:true,backgroundHeadless:true,visibleQrCandidates:2,qrUnavailable:true,noAccountAdded:true,noAuthorityAdded:true,oldUnknownAndSelectedAndProfileUnchanged:true,wholePageCaptureAttempts:0,externalRequestsSent:0,sourceFiles:await sourceHashes()},null,2),'utf8');
 }finally{await f.close();}
});
