import {app,BrowserWindow,Menu,Tray,nativeImage,dialog,shell,session,ipcMain,net} from 'electron';
import {readFile,mkdir,writeFile,cp,access} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {checkForUpdates,downloadUpdate,verifyInstaller} from '../src/updates.mjs';
import {runtimeDirectory} from './runtime-directory.mjs';
import {createUpdateFetcher} from './update-network.mjs';
import {tmpdir} from 'node:os';
import {ensureService,probeService,shutdownService,isAllowedNavigation,upgradeService} from './service-controller.mjs';
import {prepareBackend,launchBackend} from './backend.mjs';

const product='抖店折扣守护';
// Integration tests use an explicitly isolated temporary runtime and a mock
// loopback service. They never reuse the production profile or service port.
const testMode=process.env.GUARDIAN_DESKTOP_TEST==='1';
const runtime=testMode?resolve(process.env.GUARDIAN_DESKTOP_TEST_RUNTIME||''):runtimeDirectory({fallback:join(process.env.LOCALAPPDATA,'DoudianDiscountGuardianV2'),installDirectory:app.isPackaged?dirname(app.getPath('exe')):null});
const url=testMode?process.env.GUARDIAN_DESKTOP_TEST_URL:'http://127.0.0.1:19417';
if(testMode&&(!runtime.startsWith(resolve(tmpdir())+'\\')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)||url.endsWith(':19417')))throw Error('测试只能使用临时目录和独立本机端口');
const shopId=testMode?'900001':undefined;
app.setName(product);app.setAppUserModelId('cn.doudian.guardian.desktop');app.setPath('userData',join(runtime,'desktop-ui'));
const single=app.requestSingleInstanceLock();
let window,tray,exiting=false,stopping=false,refreshTimer,launchPromise,shownCloseTip=false,refreshing=false,expectedBuild;
let updateState={state:'idle'},updateBusy=false;
const updateFetch=createUpdateFetcher({systemFetch:net.fetch});
const resources=app.isPackaged?process.resourcesPath:resolve(import.meta.dirname,'..','.desktop');
const icon=join(import.meta.dirname,'assets','guardian.ico');
const message=(text,detail='')=>dialog.showMessageBox(window,{type:'info',title:product,message:text,detail});
function update(value){updateState=value;window?.webContents.send('guardian-update-state',value);return value;}
async function checkUpdate(){if(updateBusy)return updateState;updateBusy=true;update({state:'checking'});try{return update(await checkForUpdates(app.getVersion(),{fetcher:updateFetch}));}catch(e){return update({state:'error',message:e.message});}finally{updateBusy=false;}}
async function installUpdate(){
 if(updateBusy||updateState.state!=='available')return updateState;
 if(!app.isPackaged||testMode)return update({state:'error',message:'开发与测试窗口不会安装正式更新'});
 const release=updateState.release,choice=await dialog.showMessageBox(window,{type:'info',title:'安装更新',message:'安装 '+release.version+' 并重新打开程序？',detail:'本机登录、折扣历史与任务记录会保留。后台会在当前任务结束后安全更新。',buttons:['安装并重启','稍后'],defaultId:0,cancelId:1});
 if(choice.response!==0)return updateState;updateBusy=true;
 try{
  update({state:'downloading',release});const directory=join(runtime,'updates'),installer=await downloadUpdate(release,directory,{fetcher:updateFetch,onProgress:progress=>update({state:'downloading',release,progress})});
  await verifyInstaller(installer,release);const backend=await prepareBackend({bundleRoot:join(resources,'service'),runtime});
  const worker=join(directory,'install-update-'+randomUUID()+'.mjs');await cp(join(import.meta.dirname,'install-update.mjs'),worker);
  const job=join(directory,'install-job-'+randomUUID()+'.json');await writeFile(job,JSON.stringify({pid:process.pid,installer,version:release.version,sha256:release.sha256,size:release.size,executable:app.getPath('exe'),installDir:dirname(app.getPath('exe')),runtime}));
  const child=spawn(join(backend,'engine','node.exe'),[worker,job],{windowsHide:true,detached:true,stdio:'ignore'});await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
  update({state:'installing',release});exiting=true;setTimeout(()=>app.quit(),150);return updateState;
 }catch(e){return update({state:'error',message:e.message,release});}finally{updateBusy=false;}
}
async function log(error){await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'desktop-last-error.txt'),new Date().toISOString()+'\n'+String(error.stack||error),'utf8');}
function show(){if(window){if(window.isMinimized())window.restore();window.show();window.focus();}}
async function connect(){
 if(launchPromise)return launchPromise;
 launchPromise=(async()=>{
  const result=await ensureService({url,shopId,launch:async()=>{
   if(testMode)throw Error('测试不会启动正式后台');
   window?.setTitle(product+' · 正在启动后台');
   const root=await prepareBackend({bundleRoot:join(resources,'service'),runtime});await launchBackend({root,runtime,shopId});
  }});await window.loadURL(url+'/');return result;
 })();try{return await launchPromise;}finally{launchPromise=null;}
}
async function stopAndQuit(){
 if(stopping)return;stopping=true;window?.setTitle(product+' · 正在安全退出');
 try{await shutdownService({url,shopId,onProgress:()=>tray.setToolTip(product+'：等待当前动作安全结束')});exiting=true;app.quit();}
 catch(e){await log(e);await message('暂未退出，当前动作仍在收尾',e.message);}
 finally{stopping=false;}
}
async function sourceProject(){
 const target=join(app.getPath('documents'),product+'源码','desktop-'+app.getVersion());
 try{await access(target);}catch{await mkdir(target,{recursive:true});await cp(join(resources,'source'),target,{recursive:true,force:false,errorOnExist:true});}
 await shell.openPath(target);
}
async function information(){
 let s;try{s=(await probeService({url,shopId})).status;}catch{}
 await message(product+' '+app.getVersion(),['桌面窗口关闭后仍在托盘运行。','完全停止请使用“程序 → 停止守护并退出”。',
  '后台：'+(s?.running?'守护中':s?'已停止守护':'连接待核实'),'后台版本：'+(s?.version||'—'),'后台构建：'+(s?.sourceBuild?.slice(0,16)||'—'),
  '数据目录：'+runtime,'此安装器包含源码；菜单可导出可修改工程。','需要开机联网且不休眠。当前巡检不承诺秒恢复。'].join('\n'));
}
function menus(){
 const common=[{label:'打开工作台',click:show},{label:'重新连接后台',click:()=>connect().catch(e=>message('连接未完成',e.message))},
  {type:'separator'},{label:'停止守护并退出',click:stopAndQuit},{label:'仅退出窗口，后台继续',click:()=>{exiting=true;app.quit();}}];
 tray.setContextMenu(Menu.buildFromTemplate(common));
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'程序',submenu:common},{label:'查看',submenu:[{role:'reload',label:'刷新工作台'},{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'}]},
  {label:'帮助与维护',submenu:[{label:'检查更新',click:async()=>{show();const result=await checkUpdate();await message(result.state==='available'?'发现新版本 '+result.release.version:result.state==='current'?'当前已是最新发布版本':'检查更新未完成',result.message||'在“软件更新”页面查看说明并下载安装。');}},{label:'日常使用说明',click:()=>message('双击桌面图标即可打开', '首次使用：登录店铺，自动识别当前折扣，确认本店恢复规则后开启守护。\n\n关闭窗口：隐藏到托盘，后台继续。\n暂停守护：在工作台点击暂停，或从菜单“停止守护并退出”。\n换电脑：安装同一安装包并重新登录。每家店铺的资料与规则独立保存；同一店铺请保持一台电脑执行。\n\n进一步降价不会自动执行，须本人逐规格确认。')},
   {label:'打开数据目录',click:()=>shell.openPath(runtime)},{label:'导出可修改源码工程',click:()=>sourceProject().catch(e=>message('导出未完成',e.message))},{label:'版本与运行信息',click:information}]}]));
}
async function refresh(){
 if(exiting||stopping||refreshing||launchPromise)return;refreshing=true;
 try{const p=await probeService({url,shopId});const s=p.status;
  if(!testMode&&s&&expectedBuild&&s.sourceBuild!==expectedBuild){
   window?.setTitle(product+' · 新版本等待后台空闲');
   const result=await upgradeService({url,shopId,expectedBuild,expectedVersion:app.getVersion(),start:connect});
   if(result.state==='upgraded')await connect();return;
  }
  const label=s?(s.running?(s.unknown?'守护中 · 有结果待核实':'后台守护中'):'守护已停止'):'后台未启动';
  window?.setTitle(product+' · '+label);tray?.setToolTip(product+'：'+label);
 }catch(e){tray?.setToolTip(product+'：后台连接待核实');await log(e);}finally{refreshing=false;}
}
if(!single){app.quit();}else{
 app.on('second-instance',show);app.on('activate',show);
 app.on('window-all-closed',()=>{});
 app.on('before-quit',()=>{exiting=true;clearInterval(refreshTimer);});
 void app.whenReady().then(async()=>{await mkdir(runtime,{recursive:true});
 if(!testMode)expectedBuild=JSON.parse(await readFile(join(resources,'service','bundle-info.json'),'utf8')).sourceBuild;
 const appSession=session.fromPartition('persist:guardian-workbench');
 appSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));appSession.setPermissionCheckHandler(()=>false);
 appSession.on('will-download',e=>e.preventDefault());
 appSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isAllowedNavigation(details.url,url)}));
 window=new BrowserWindow({title:product,width:1280,height:900,minWidth:760,minHeight:650,show:false,backgroundColor:'#f5f6fa',icon,
  webPreferences:{session:appSession,preload:join(import.meta.dirname,'preload.cjs'),additionalArguments:['--guardian-version='+app.getVersion()],sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webSecurity:true,webviewTag:false}});
 const senderAllowed=event=>event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&isAllowedNavigation(event.senderFrame.url,url);
 for(const [channel,fn] of [['guardian-update-check',checkUpdate],['guardian-update-install',installUpdate],['guardian-update-status',()=>updateState]])ipcMain.handle(channel,async event=>{if(!senderAllowed(event))throw Error('更新请求来源无效');return await fn();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(e,target)=>{if(!isAllowedNavigation(target,url))e.preventDefault();});
 window.webContents.on('will-attach-webview',e=>e.preventDefault());
 window.on('close',e=>{if(!exiting){e.preventDefault();window.hide();if(!shownCloseTip&&!testMode){shownCloseTip=true;tray.displayBalloon({title:product,content:'窗口已收起，后台继续守护。双击托盘图标可打开。',respectQuietTime:true});}}});
 tray=new Tray(nativeImage.createFromPath(icon));tray.setToolTip(product);tray.on('double-click',show);menus();
 try{await connect();show();}catch(e){await log(e);show();await message('后台连接未完成',e.message+'\n可以使用“程序 → 重新连接后台”。');}
 refreshTimer=setInterval(()=>void refresh(),5000);await refresh();
 }).catch(async error=>{await log(error);dialog.showErrorBox(product+'启动失败',error.message);app.quit();});
}
