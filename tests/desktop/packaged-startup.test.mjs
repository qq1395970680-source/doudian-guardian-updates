import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';

const executablePath=process.env.GUARDIAN_TEST_DESKTOP_EXE;
test('actual installer desktop renders the six-page workbench without startup exceptions or taking focus',
 {timeout:60000,skip:!executablePath?'Set GUARDIAN_TEST_DESKTOP_EXE to the extracted installer executable':false},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-packaged-startup-')),journal=new Journal(':memory:');let desktop;
 let starts=0,stops=0;
 const service={running:true,busy:false,status(){return{running:this.running,busy:this.busy,verified:0,unknown:0,blocked:0,tasks:[]};},start(){starts++;},stop(){stops++;this.running=false;}};
 const backend=await createApp({config:{shopId:'900001',name:'安装器独立启动验收'},runtime,port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform:{progress:{stage:'本地隔离验收'}}}});
 const env={...process.env,GUARDIAN_DESKTOP_TEST:'1',GUARDIAN_DESKTOP_TEST_QUIET:'1',GUARDIAN_DESKTOP_TEST_RUNTIME:runtime,GUARDIAN_DESKTOP_TEST_URL:backend.url};delete env.ELECTRON_RUN_AS_NODE;
 try{
  desktop=await _electron.launch({executablePath,args:[],env,timeout:30000});
  const page=await desktop.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByText('安装器独立启动验收 · 900001',{exact:true}).waitFor();
  const expected=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
  const app=await desktop.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),visible:BrowserWindow.getAllWindows().some(w=>w.isVisible())}));
  assert.deepEqual(app,{packaged:true,version:expected,visible:false});
  assert.equal(await page.evaluate(()=>window.guardianDesktop.version),expected);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  for(const [view,label] of [['overview','折扣概览'],['workspace','恢复工作台'],['recoveries','恢复记录'],['accounts','店铺管理'],['activity','运行记录'],['updates','软件更新']]){
   await page.locator('nav [data-view="'+view+'"]').click();
   await page.locator('#view-'+view+' h1').filter({hasText:label}).waitFor();
  }
  await page.locator('nav [data-view="overview"]').click();
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/desktop-packaged-startup.png')});
  assert.equal(starts,0);assert.equal(stops,0);assert.deepEqual(errors,[]);
 }finally{await desktop?.close().catch(()=>{});await backend.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
