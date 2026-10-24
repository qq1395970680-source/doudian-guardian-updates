import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
test('login expiry is conspicuous on every view and relogin reuses this account profile',{timeout:60000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-auth-ui-')),j=new Journal(':memory:');let called=null;
 const identity={shopId:'900001',name:'登录测试店铺'},dedicated={loginMode:false,close:async()=>{dedicated.loginMode=false;},openLogin:async args=>{called=args;dedicated.loginMode=true;return args.profileKey;},page:async()=>({goto:async()=>{}})};
 const app=await createApp({port:0,runtime,config:{shopId:identity.shopId,name:identity.name,profileKey:'signin-stable'},dependencies:{journal:j,browser:dedicated,
  platform:{base:'https://fxg.jinritemai.com',progress:{},probe:async()=>identity,identify:async()=>identity,discover:async()=>({activeComplete:true,baselines:[],errors:[]})},
  service:{running:false,busy:false,status:()=>({tasks:[],unknown:0,lastRun:{ok:false,code:'LOGIN_REQUIRED',finishedAt:Date.now()-1000}}),stop(){},start(){assert.fail('No new execution consent was granted');}}}});
 const ui=await chromium.launch({headless:true}),page=await ui.newPage({viewport:{width:1280,height:850}});
 try{
  await page.goto(app.url);await page.locator('#login-alert:visible').waitFor();
  assert.match(await page.locator('#hero-title').innerText(),/登录已失效/);assert.equal(await page.locator('#start').isDisabled(),true);
  assert.equal(await page.locator('#shop-dot').evaluate(e=>e.classList.contains('online')),false);
  await page.screenshot({path:resolve('artifacts/beta38-login-expired-ui.png'),fullPage:false,animations:'disabled'});
  await page.locator('#reauthenticate').click();await page.waitForFunction(()=>document.querySelector('#reauthenticate').textContent==='登录完成');
  assert.equal(called.profileKey,'signin-stable');assert.equal(called.shopId,'900001');
  await page.locator('#reauthenticate').click();await page.locator('#login-alert').waitFor({state:'hidden'});
  await page.locator('[data-view="accounts"]').click();assert.equal(await page.locator('#add-account').isVisible(),true);
  await writeFile(resolve('artifacts/beta38-auth-ui.json'),JSON.stringify({localFixtureOnly:true,expiredLoginVisible:true,staleConnectionNotGreen:true,originalProfileReused:true,reauthenticationVerified:true,noExecutionStarted:true},null,2)+'\n');
 }finally{await ui.close();await app.close();await rm(runtime,{recursive:true,force:true});}
});
