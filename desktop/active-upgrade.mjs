import {readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {validateBundle} from './backend.mjs';
import {probeService,postControl} from './service-controller.mjs';
import {readUpgradeHandoff,saveUpgradeHandoff} from './upgrade-handoff.mjs';
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};

const same=(a,b)=>a.instance===b.instance&&a.sourceBuild===b.sourceBuild&&a.shopId===b.shopId&&a.startedAt===b.startedAt;
// Maintenance 503, reset sockets and bounded read timeouts are uncertainty,
// never evidence of absence. Only use this AFTER a validated stop/checkpoint,
// or while resuming that same durable handoff.
export function isUpgradeProbeUncertain(error,seen=new Set()){
 if(!error||seen.has(error))return false;seen.add(error);
 if(error.code==='GUARDIAN_PROBE_IDENTITY'||error instanceof SyntaxError)return false;
 if(error.code==='GUARDIAN_PROBE_HTTP')return error.status===503;
 if(/^后台正在维护或返回异常（503）/.test(error.message||''))return true;
 if(['ECONNREFUSED','ECONNRESET','EPIPE','ECONNABORTED','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error.code)||['AbortError','TimeoutError'].includes(error.name))return true;
 if(error.errors?.length)return error.errors.every(value=>isUpgradeProbeUncertain(value,seen));
 return isUpgradeProbeUncertain(error.cause,seen);
}
const waitingProbe=async(probe,args)=>{try{return await probe(args);}catch(error){if(!isUpgradeProbeUncertain(error))throw error;return{state:'uncertain',message:error.message};}};
// Authorized application updates may interrupt work. Only an owned worker and
// its dedicated browser tree are eligible; business results are NEVER guessed.
export async function interruptForUpgrade({url,runtime,expectedInstance,probe=probeService,control=postControl,inspect,terminate,journalCheck,
 readRecord=async()=>JSON.parse(await readFile(join(runtime,'service-status.json'),'utf8')),validate=validateBundle,isAlive=processAlive,
 now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),shouldContinue=()=>true,graceMs=1500,exitMs=15000,targetBuild,targetVersion,resumeOnLaunch=false}){
 if(!/^[a-f0-9]{64}$/.test(targetBuild||'')||typeof targetVersion!=='string'||!targetVersion)throw Error('缺少当前安装包的目标构建身份');
 const handoffOptions={runtime,targetBuild,targetVersion},existing=await readUpgradeHandoff(handoffOptions);
 const first=await probe({url});if(first.state!=='ready')throw Error('旧后台未连接，不能确定任务及进程身份');const original=first.status;
 if(expectedInstance&&original.instance!==expectedInstance)throw Error('旧后台实例已变化，未接管');
 const record=await readRecord(),root=resolve(record.sourceRoot),inside=relative(join(resolve(runtime),'versions'),root);
 // Registration is written after initial login/catalog work and can be much
 // later than process creation. The native helper checks the real creation
 // time against original.startedAt, not this publication timestamp.
 if(record.url!==url||record.sourceBuild!==original.sourceBuild||record.shopId!==original.shopId||!Number.isInteger(record.pid)||!inside||inside.startsWith('..')||isAbsolute(inside)||!Number.isFinite(record.startedAt)||record.startedAt<original.startedAt||record.startedAt>now()+5000)throw Error('旧后台登记、路径或店铺身份不匹配');
 if(!inspect||!terminate||!journalCheck)throw Error('缺少进程归属或完整数据库核验，未接管');
 await validate(root);const info=JSON.parse(await readFile(join(root,'bundle-info.json'),'utf8'));if(info.sourceBuild!==original.sourceBuild)throw Error('旧后台文件与运行构建不一致');
 let expected={pid:record.pid,instance:original.instance,sourceBuild:original.sourceBuild,startedAt:original.startedAt,shopId:original.shopId,url,sourceRoot:root,runtime:resolve(runtime)};const owned={pid:record.pid,exe:join(root,'engine','node.exe'),startedAt:original.startedAt,sourceRoot:root,runtime:resolve(runtime)};
 const identity=await inspect(owned);if(!shouldContinue())throw Error('更新已取消');
 if(!Array.isArray(identity)||!identity.length||identity[0].pid!==record.pid||identity.some(p=>!Number.isInteger(p.pid)||p.pid<=0)||new Set(identity.map(p=>p.pid)).size!==identity.length)throw Error('旧进程及专用浏览器身份列表无效');
 expected.processIds=identity.map(p=>p.pid);
 if(existing){const prior=existing.expected;if(existing.phase!=='prepared'||prior.pid!==expected.pid||prior.instance!==expected.instance||prior.sourceBuild!==expected.sourceBuild||prior.shopId!==expected.shopId||prior.startedAt!==expected.startedAt||prior.url!==url||prior.runtime!==resolve(runtime)||prior.sourceRoot!==root)throw Error('未完成切换的旧实例身份已变化');expected=prior;}
 const ack=await control({url,shopId:original.shopId,expectedInstance:original.instance,path:'stop',args:{forUpgrade:true,expectedInstance:original.instance}});
 if(ack?.ok!==true||ack.running!==false||!same(original,ack))throw Error('没有收到原实例停止派发的确认');
 const checkpoint=existing?{complete:true,checkpointSaved:true,cutoverId:existing.cutoverId}:await journalCheck('interrupt-checkpoint',{expected});if(checkpoint?.complete!==true||checkpoint.checkpointSaved!==true||!/^[a-f0-9-]{36}$/.test(checkpoint.cutoverId||''))throw Error('完整任务备份未确认，未关闭旧进程');
 const handoff=await saveUpgradeHandoff({schema:1,runtime:resolve(runtime),targetBuild,targetVersion,phase:'prepared',expected,processIds:[...new Set([...(existing?.processIds||[]),...identity.map(p=>p.pid)])],cutoverId:checkpoint.cutoverId,resumeOnLaunch:existing?.resumeOnLaunch??resumeOnLaunch,createdAt:existing?.createdAt||now()});
 let absent=false,shutdown=false,lastProbeError='';const gracefulUntil=now()+graceMs;
 while(now()<gracefulUntil){
  if(!shouldContinue())throw Error('更新已取消；任务备份保留');
  const p=await waitingProbe(probe,{url,shopId:original.shopId,timeoutMs:Math.max(100,Math.min(1000,gracefulUntil-now()))});if(p.state==='absent'){absent=true;break;}
  if(p.state==='uncertain'){lastProbeError=p.message;await sleep(Math.min(150,Math.max(1,gracefulUntil-now())));continue;}
  if(!same(original,p.status)||p.status.running!==false)throw Error('停止派发后实例、店铺或运行状态变化');
  if(!shutdown&&!p.status.busy&&!p.status.action){shutdown=true;try{await control({url,shopId:original.shopId,expectedInstance:original.instance,path:'shutdown',timeoutMs:1000,args:{resumeOnLaunch:false}});}catch(error){if(!isUpgradeProbeUncertain(error)&&error.message!=='后台尚未连接')throw error;lastProbeError=error.message;}}
  await sleep(Math.min(150,Math.max(1,gracefulUntil-now())));
 }
 if(!absent||isAlive(record.pid)){
  if(!shouldContinue())throw Error('更新已取消；任务备份保留');
  const p=await waitingProbe(probe,{url,shopId:original.shopId,timeoutMs:1000});if(p.state==='ready'&&(!same(original,p.status)||p.status.running!==false))throw Error('关闭前旧后台身份或派发状态变化');
  if(p.state==='uncertain')lastProbeError=p.message;
  // A submit already sent before Stop has its durable intent recorded. The
  // native helper revalidates root identity and every child before closing.
  if(isAlive(record.pid)){
   let closed;try{closed=await terminate(owned,identity);}
   catch(error){
    // The acknowledged old worker may finish graceful shutdown between the
    // liveness probe and the native helper opening its process handles.
    // An error is never proof of exit; recheck EVERY recorded owned PID.
    if(handoff.processIds.some(pid=>isAlive(pid)))throw error;
    closed={closed:true};
   }
   if(closed?.closed!==true)throw Error('旧进程及专用浏览器退出未确认');
  }
 }
 const deadline=now()+exitMs;let exited=false;
 while(now()<deadline){const p=await waitingProbe(probe,{url,shopId:original.shopId,timeoutMs:Math.max(100,Math.min(1000,deadline-now()))});if(p.state==='absent'&&!handoff.processIds.some(pid=>isAlive(pid))){exited=true;break;}if(p.state==='uncertain')lastProbeError=p.message;if(p.state==='ready'&&!same(original,p.status))throw Error('端口出现另一实例，不启动第二后台');await sleep(150);}
 if(!exited)throw Error('旧 HTTP 或进程仍未退出，不启动新版'+(lastProbeError?'；最近连接状态：'+lastProbeError:''));
 if(!shouldContinue())throw Error('更新已取消；旧任务记录保留');
 const result=await journalCheck('interrupt-finalize',{expected,cutoverId:checkpoint.cutoverId});
 if(result?.complete!==true||result.recordsPreserved!==true||result.tasksCheckpointed!==true||result.oldProcessExited!==true)throw Error('离线恢复记录核验失败，不启动新版');
 await saveUpgradeHandoff({...handoff,phase:'finalized',verifiedAt:now()});return{ok:true,state:'stopped',...result,resumeOnLaunch:handoff.resumeOnLaunch};
}
// Called before ensureService on every reconnect/reopen. A missing old port
// never bypasses the SAME cutover's final backup and task normalization.
export async function resumeUpgradeHandoff({runtime,targetBuild,targetVersion,journalCheck,probe=probeService,isAlive=processAlive,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),waitMs=15000}){
 const options={runtime,targetBuild,targetVersion},pending=await readUpgradeHandoff(options);if(!pending)return null;
 const until=now()+waitMs,maxAttempts=Math.max(1,Math.ceil(waitMs/150)+1);let p;
 for(let attempt=0;attempt<maxAttempts;attempt++){
  p=await waitingProbe(probe,{url:pending.expected.url,shopId:pending.expected.shopId,timeoutMs:Math.max(100,Math.min(1000,until-now()))});
  if(p.state!=='uncertain')break;
  if(now()>=until||attempt===maxAttempts-1)throw Error('维护中的后台连接仍未确定，保留切换记录且不启动新版：'+p.message);
  await sleep(Math.min(150,Math.max(1,until-now())));
 }
 if(p.state==='ready'){
  if(['finalized','launching'].includes(pending.phase)&&p.status.sourceBuild===targetBuild&&p.status.version===targetVersion&&p.status.instance!==pending.expected.instance)return{state:'current',status:p.status,pending};
  if(pending.phase==='prepared'&&same(pending.expected,p.status))return{state:'old-present',pending};
  throw Error('未完成切换的端口出现了未经核验的实例，未启动第二后台');
 }
 if(pending.phase==='launching')return{state:'launching',pending};
 if(pending.processIds.some(pid=>isAlive(pid)))throw Error('旧后台或专用浏览器仍在，保留切换记录且不启动新版');
 const proof=await journalCheck('interrupt-finalize',{expected:pending.expected,cutoverId:pending.cutoverId});
 if(proof?.complete!==true||proof.recordsPreserved!==true||proof.tasksCheckpointed!==true||proof.oldProcessExited!==true)throw Error('重试的离线恢复记录核验失败');
 const value=await saveUpgradeHandoff({...pending,phase:'finalized',verifiedAt:now()});return{state:'finalized',pending:value};
}
