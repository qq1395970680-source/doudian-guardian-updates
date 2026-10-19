import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {_electron} from 'playwright';
import electron from 'electron';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';

test('native desktop window, tray hide, single instance, isolated renderer, and graceful exit', {timeout:120000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-desktop-test-')),journal=new Journal(':memory:');let stops=0,starts=0,desktop;
 const service={running:true,busy:false,status(){return{running:this.running,busy:this.busy,verified:0,unknown:0,blocked:0,tasks:[]};},start(){starts++;},stop(){stops++;this.running=false;}};
 const backend=await createApp({config:{shopId:'900001',name:'桌面隔离验收'},runtime,port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform:{progress:{stage:'本地测试'}}}});
 const executablePath=process.env.GUARDIAN_TEST_DESKTOP_EXE||electron;
 const args=process.env.GUARDIAN_TEST_DESKTOP_EXE?[]:[resolve('.')];
 const env={...process.env,GUARDIAN_DESKTOP_TEST:'1',GUARDIAN_DESKTOP_TEST_RUNTIME:runtime,GUARDIAN_DESKTOP_TEST_URL:backend.url};delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){desktop=await _electron.launch({executablePath,args,env,timeout:30000});const page=await desktop.firstWindow();await page.getByText('桌面隔离验收 · 900001',{exact:true}).waitFor();return page;}
 try{
  const page=await launch();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  assert.equal(starts,0);assert.equal(stops,0);
  const prefs=await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{sandbox:p.sandbox,node:p.nodeIntegration,isolated:p.contextIsolation};});
  assert.deepEqual(prefs,{sandbox:true,node:false,isolated:true});
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',process.env.GUARDIAN_TEST_DESKTOP_EXE?'desktop-packaged.png':'desktop-source.png')});
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  assert.equal(service.running,true);assert.equal(stops,0);
  const second=spawn(executablePath,args,{env,windowsHide:true,stdio:'ignore'});
  const secondCode=await new Promise((ok,no)=>{second.once('error',no);second.once('exit',ok);});assert.equal(secondCode,0);
  await page.waitForFunction(()=>document.visibilityState==='visible');
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);assert.equal(starts,0);
  const closed=desktop.waitForEvent('close');await desktop.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(x=>x.label==='仅退出窗口，后台继续').click());await closed;desktop=null;
  assert.equal((await(await fetch(backend.url+'/api/status')).json()).running,true);
  await launch();const exited=desktop.waitForEvent('close');await desktop.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(x=>x.label==='停止守护并退出').click());await exited;desktop=null;
  assert.ok(stops>=1);assert.equal(service.running,false);assert.deepEqual(errors,[]);
 }finally{await desktop?.close().catch(()=>{});await backend.close();await rm(runtime,{recursive:true,force:true});}
});
