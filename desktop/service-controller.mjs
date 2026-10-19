import {compareVersions} from '../src/updates.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function refused(error){
 if(error?.code==='ECONNREFUSED')return true;
 if(error?.errors?.length)return error.errors.every(refused);
 return error?.cause?refused(error.cause):false;
}
function identity(status,shopId){
 if(status?.build!=='isolated-headless-journal'||shopId!==undefined&&status.shopId!==shopId||!status.instance||!status.sourceBuild||status.shopId!==null&&!/^\d{3,25}$/.test(status.shopId))
  throw Error('此端口不是所选店铺的折扣守护后台，未启动另一实例。');
 return status;
}
export function isAllowedNavigation(target,origin){
 try{const u=new URL(target);return u.origin===origin&&u.protocol==='http:'&&!u.username&&!u.password;}catch{return false;}
}
export async function probeService({url,shopId,timeoutMs=3000}){
 let response;
 try{response=await fetch(url+'/api/status',{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
 catch(e){if(refused(e))return{state:'absent'};throw Error('后台连接暂不确定，保留现有进程。'+e.message,{cause:e});}
 if(!response.ok)throw Error('后台正在维护或返回异常（'+response.status+'），未启动第二个实例。');
 const status=identity(await response.json(),shopId);return{state:'ready',status};
}
export async function ensureService(options){
 const {launch,probe=probeService,sleep=pause,now=Date.now,readyTimeoutMs=60000}=options;
 const first=await probe(options);if(first.state==='ready')return{reused:true,status:first.status};
 if(first.state!=='absent')throw Error('不能确定后台已退出');
 await launch();const until=now()+readyTimeoutMs;
 while(now()<until){await sleep(400);const next=await probe(options);if(next.state==='ready')return{reused:false,status:next.status};}
 throw Error('后台尚未就绪，请查看运行日志；没有重复启动。');
}
export async function postControl({url,shopId,path,args={},timeoutMs=10000}){
 if(!['stop','shutdown'].includes(path))throw Error('桌面控制操作无效');
 const s=await probeService({url,shopId,timeoutMs});if(s.state!=='ready')throw Error('后台尚未连接');
 const page=await fetch(url+'/',{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(!page.ok)throw Error('无法核对本机工作台');
 const token=(await page.text()).match(/<script nonce="([a-f0-9]{64})"/)?.[1];
 if(!token)throw Error('本机工作台校验失败');
 const response=await fetch(url+'/api/'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
  headers:{'Content-Type':'application/json',Origin:url,'X-Guardian-Token':token},body:JSON.stringify(args)});
 const body=await response.json();if(!response.ok||body.ok!==true)throw Error(body.message||'后台操作未完成');return body;
}
export async function shutdownService(options){
 const {probe=probeService,control=postControl,sleep=pause,now=Date.now,timeoutMs=180000,onProgress=()=>{}}=options;
 const first=await probe(options);if(first.state==='absent')return;
 await control({...options,path:'stop'});const until=now()+timeoutMs;
 while(now()<until){
  const current=await probe(options);if(current.state==='absent')return;
  if(!current.status.busy&&!current.status.action&&!current.status.running){
   await control({...options,path:'shutdown'});
   while(now()<until){await sleep(200);let after;try{after=await probe(options);}catch{continue;}
    if(after.state==='absent')return;
    if(after.status?.instance!==current.status.instance)throw Error('后台实例已改变，保留窗口核查');
   }
   throw Error('后台尚未确认退出，保留窗口和任务记录');
  }
  onProgress(current.status);await sleep(500);
 }
 throw Error('当前动作仍在收尾，已请求停止守护。保留后台与任务记录，请稍后再次退出。');
}
export async function upgradeService(options){
 const {probe=probeService,control=postControl,sleep=pause,now=Date.now,start,expectedBuild,timeoutMs=60000}=options;
 const p=await probe(options);if(p.state!=='ready')return{state:'absent'};
 const s=p.status;if(s.sourceBuild===expectedBuild)return{state:'current'};
 if(options.expectedVersion&&compareVersions(options.expectedVersion,s.version)<=0)return{state:'newer-service'};
 if(s.busy||s.action||s.unknown!==0)return{state:'pending'};
 // The server independently rejects BUSY if a new patrol started in this gap.
 // Unknown submissions are never cleared or reconstructed by the launcher.
 await control({...options,path:'shutdown',args:{resumeOnLaunch:s.running===true}});
 const until=now()+timeoutMs;
 while(now()<until){
  await sleep(400);let after;
  try{after=await probe(options);}catch{continue;}
  if(after.state==='absent'){await start();return{state:'upgraded'};}
  if(after.status?.instance!==s.instance)throw Error('后台实例已改变，取消自动切换');
 }
 throw Error('旧后台尚未确认退出，没有启动新版本');
}
