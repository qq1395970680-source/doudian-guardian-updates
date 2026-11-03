import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright';
import electron from 'electron';

const version=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
async function fixture({unknown=false}={}){
 let target=false,running=true,stops=0,shutdowns=0,port,closeTimer;
 const status=()=>({build:'isolated-headless-journal',version:target?version:'2.0.0-beta.30',sourceBuild:(target?'b':'a').repeat(64),instance:target?'new-native-test':'old-native-test',startedAt:1,
  shopId:'900001',running:target||running,busy:!target&&unknown,unknown:unknown?1:0,action:null,tasks:unknown?[{phase:'unknown'}]:[],loginOpen:false,progress:{stage:'核对当前活动',read:10,total:20}});
 const server=createServer((req,res)=>{
  if(req.url==='/api/status'){res.end(JSON.stringify(status()));return;}
  if(req.url==='/api/stop'){stops++;running=false;res.end(JSON.stringify({ok:true,...status()}));return;}
  if(req.url==='/api/shutdown'){
   shutdowns++;res.end('{"ok":true}');
   closeTimer=setTimeout(()=>{server.close();server.closeAllConnections();},1500);return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(target?'<h1 id="target-ready">新后台工作台</h1>':'<p>旧页面没有更新状态监听器</p><script nonce="'+'a'.repeat(64)+'"></script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 return{url:'http://127.0.0.1:'+port,counts:()=>({stops,shutdowns}),
  startTarget:async()=>{assert.equal(server.listening,false,'the old listener must exit before the coordinator starts its replacement');target=true;await new Promise(r=>server.listen(port,'127.0.0.1',r));},
  close:async()=>{clearTimeout(closeTimer);server.close();server.closeAllConnections();}};
}
for(const unknown of [false,true])test(`native desktop owns visible upgrade phases independently of old HTML, unknown=${unknown}`,{timeout:45000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-desktop-upgrade-')),backend=await fixture({unknown});let desktop;
 const env={...process.env,GUARDIAN_DESKTOP_TEST:'1',GUARDIAN_DESKTOP_TEST_UPGRADE:'1',GUARDIAN_DESKTOP_TEST_EXPECTED_BUILD:'b'.repeat(64),
  GUARDIAN_DESKTOP_TEST_RUNTIME:runtime,GUARDIAN_DESKTOP_TEST_URL:backend.url,GUARDIAN_TEST_UPGRADE_TIMEOUT:'600',GUARDIAN_DESKTOP_TEST_QUIET:'1'};delete env.ELECTRON_RUN_AS_NODE;
 try{
  desktop=await _electron.launch({executablePath:process.env.GUARDIAN_TEST_DESKTOP_EXE||electron,args:process.env.GUARDIAN_TEST_DESKTOP_EXE?[]:[resolve('.')],env,timeout:30000});
  const page=await desktop.firstWindow();await page.locator('#expected').waitFor();
  assert.equal(await page.locator('#expected').textContent(),version);assert.equal(await page.locator('#actual').textContent(),'2.0.0-beta.30');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  {
   // Keep the old port absent until the real coordinator requests a launch.
   // A fixed 500ms self-restart races both exit verification and cold startup.
   const until=Date.now()+15000;let phase;
   while(Date.now()<until){const state=await page.evaluate(()=>window.guardianDesktop.backendUpgradeStatus());phase=state.phase;if(phase==='starting')break;assert.notEqual(phase,'blocked',JSON.stringify(state));await new Promise(r=>setTimeout(r,30));}
   assert.equal(phase,'starting');await backend.startTarget();
   await page.locator('#target-ready').waitFor({timeout:15000});
   const state=await page.evaluate(()=>window.guardianDesktop.backendUpgradeStatus());assert.equal(state.phase,'ready');assert.equal(state.actualVersion,version);
   assert.deepEqual(backend.counts(),{stops:1,shutdowns:1});assert.equal(state.oldStopped,true);assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false,'quiet tests never show or focus a real window');
  }
 }catch(error){
  if(desktop){try{const page=await desktop.firstWindow(),state=await page.evaluate(()=>window.guardianDesktop.backendUpgradeStatus());console.error('UPGRADE_DIAGNOSTIC '+JSON.stringify({unknown,counts:backend.counts(),url:page.url(),state}));}catch{}}
  throw error;
 }finally{await desktop?.close().catch(()=>{});await backend.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
