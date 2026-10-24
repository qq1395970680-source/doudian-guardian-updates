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
 let target=false,stops=0,shutdowns=0,port;
 const status=()=>({build:'isolated-headless-journal',version:target?version:'2.0.0-beta.30',sourceBuild:(target?'b':'a').repeat(64),instance:target?'new-native-test':'old-native-test',startedAt:1,
  shopId:'900001',running:true,busy:unknown,unknown:unknown?1:0,action:null,tasks:unknown?[{phase:'unknown'}]:[],loginOpen:false,progress:{stage:'核对当前活动',read:10,total:20}});
 const server=createServer((req,res)=>{
  if(req.url==='/api/status'){res.end(JSON.stringify(status()));return;}
  if(req.url==='/api/stop'){stops++;res.end(JSON.stringify({ok:true,...status(),running:false}));return;}
  if(req.url==='/api/shutdown'){
   shutdowns++;res.end('{"ok":true}');
   setTimeout(()=>{server.close();server.closeAllConnections();setTimeout(()=>{target=true;server.listen(port,'127.0.0.1');},500);},1500);return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(target?'<h1 id="target-ready">新后台工作台</h1>':'<p>旧页面没有更新状态监听器</p><script nonce="'+'a'.repeat(64)+'"></script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 return{url:'http://127.0.0.1:'+port,counts:()=>({stops,shutdowns}),close:async()=>{server.close();server.closeAllConnections();}};
}
for(const unknown of [false,true])test(`native desktop owns visible upgrade phases independently of old HTML, unknown=${unknown}`,{timeout:45000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-desktop-upgrade-')),backend=await fixture({unknown});let desktop;
 const env={...process.env,GUARDIAN_DESKTOP_TEST:'1',GUARDIAN_DESKTOP_TEST_UPGRADE:'1',GUARDIAN_DESKTOP_TEST_EXPECTED_BUILD:'b'.repeat(64),
  GUARDIAN_DESKTOP_TEST_RUNTIME:runtime,GUARDIAN_DESKTOP_TEST_URL:backend.url,GUARDIAN_TEST_UPGRADE_TIMEOUT:'600'};delete env.ELECTRON_RUN_AS_NODE;
 try{
  desktop=await _electron.launch({executablePath:process.env.GUARDIAN_TEST_DESKTOP_EXE||electron,args:process.env.GUARDIAN_TEST_DESKTOP_EXE?[]:[resolve('.')],env,timeout:30000});
  const page=await desktop.firstWindow();await page.locator('#expected').waitFor();
  assert.equal(await page.locator('#expected').textContent(),version);assert.equal(await page.locator('#actual').textContent(),'2.0.0-beta.30');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  if(unknown){
   await page.getByText('后台更新尚未完成',{exact:true}).waitFor();assert.match(await page.locator('#message').textContent(),/待核实提交/);
   assert.equal(await page.locator('#retry').isVisible(),true);assert.deepEqual(backend.counts(),{stops:0,shutdowns:0});
   const state=await page.evaluate(()=>window.guardianDesktop.backendUpgradeStatus());assert.equal(state.phase,'blocked');assert.equal(state.code,'UPGRADE_PENDING_SUBMISSIONS');
   await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts','backend-upgrade-desktop-blocked.png')});
  }else{
   await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts','backend-upgrade-desktop-stopping.png')});
   await page.locator('#target-ready').waitFor({timeout:15000});
   const state=await page.evaluate(()=>window.guardianDesktop.backendUpgradeStatus());assert.equal(state.phase,'ready');assert.equal(state.actualVersion,version);
   assert.deepEqual(backend.counts(),{stops:0,shutdowns:1});
  }
 }finally{await desktop?.close().catch(()=>{});await backend.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
