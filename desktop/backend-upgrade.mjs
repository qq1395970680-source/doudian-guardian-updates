import {isReadonlyStage} from './readonly-stage.mjs';
const same=(a,b)=>a.instance===b.instance&&a.sourceBuild===b.sourceBuild&&a.shopId===b.shopId&&a.startedAt===b.startedAt;
const pending=s=>s.unknown!==0||Array.isArray(s.tasks)&&s.tasks.some(t=>!['verified','blocked'].includes(t.phase));
const readonly=s=>!pending(s)&&!s.loginOpen&&Array.isArray(s.tasks)&&isReadonlyStage(s.progress?.stage)&&
 (!s.action||['连接店铺','同步当前折扣','连接店铺并同步折扣'].includes(s.action));

// Counts must move, not just a heartbeat, a retry operation ID, or a repeated
// list poll while a detail reader remains stuck. Each successful patrol starts
// a new set of high-water marks.
export class UpgradeProgress {
 constructor(now){this.at=now;this.high={};this.completed=0;this.detailsSeen=false;}
 observe(s,now){
  let changed=false;const completed=s.lastSuccessfulRun?.finishedAt||0;
  if(completed>this.completed){if(this.completed)changed=true;this.completed=completed;this.high={};this.detailsSeen=false;}
  const p=s.progress||{},details=/核对|补读/.test(p.stage||'');
  if(details)this.detailsSeen=true;
  const values=details?{read:p.read,activeRead:p.activeRead}:!this.detailsSeen?{page:p.page,campaigns:p.campaigns}:{};
  for(const [key,value] of Object.entries(values))if(Number.isFinite(value)&&value>=0&&value>(this.high[key]??-1)){this.high[key]=value;changed=true;}
  if(changed)this.at=now;return changed;
 }
}

export class BackendUpgrade {
 constructor(){this.inFlight=null;this.blocked=null;this.resumeIntent=null;this.state={phase:'idle'};}
 reset(){if(this.inFlight)throw Error('后台更新仍在进行');this.blocked=null;}
 run(options){if(this.inFlight)return this.inFlight;this.inFlight=this.execute(options).finally(()=>{this.inFlight=null;});return this.inFlight;}
 async execute({probe,control,start,takeover,onState=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),
  shouldContinue=()=>true,expectedBuild,expectedVersion,url,shopId,timeoutMs=300000,stallMs=120000,pollMs=2000,
  shutdownWaitMs=30000,readyTimeoutMs=60000}){
  let original,stopped=false,shutdown=false,launched=false,forceAttempted=false,resumeOnLaunch=false,shutdownAt=0;
  const began=now(),progress=new UpgradeProgress(began);let lastStatus,connectionFailedAt=null;
  const emit=(phase,message,extra={})=>{
   this.state={phase,message,expectedVersion,expectedBuild,actualVersion:lastStatus?.version||null,actualBuild:lastStatus?.sourceBuild||null,
    instance:lastStatus?.instance||null,shopId:lastStatus?.shopId??null,beganAt:began,elapsedMs:now()-began,
    noProgressMs:Math.max(0,now()-progress.at),timeoutMs,stallMs,oldStopped:stopped,resumeOnLaunch,
    progress:lastStatus?.progress?Object.fromEntries(['stage','read','total','activeRead','activeTotal','page','campaigns'].filter(k=>lastStatus.progress[k]!=null).map(k=>[k,lastStatus.progress[k]])):null,...extra};
   onState(this.state);return this.state;
  };
  const block=(code,message)=>{const state=emit('blocked',message,{code});this.blocked={instance:original?.instance,expectedBuild,state};return{state:'blocked',code,message,status:lastStatus,upgrade:state};};
  const cancelled=()=>{this.resumeIntent=null;return{state:'cancelled',upgrade:emit('cancelled','后台更新已停止，现有任务和结果核实记录保留')};};
  const launch=async()=>{
   if(!shouldContinue())return cancelled();
   if(launched)return block('UPGRADE_DUPLICATE_START','新版启动已发起，未重复启动另一个后台');
   launched=true;emit('starting','旧后台已确认退出，正在启动新版后台');
   await start({resumeOnLaunch});const deadline=now()+readyTimeoutMs;
   while(now()<deadline){
    if(!shouldContinue())return cancelled();
    let p;try{p=await probe({url,shopId:original.shopId});}catch{await sleep(pollMs);continue;}
    if(p.state==='ready'){
     lastStatus=p.status;
     if(lastStatus.sourceBuild!==expectedBuild||expectedVersion&&lastStatus.version!==expectedVersion)
      return block('UPGRADE_BUILD_MISMATCH','新后台返回的版本或构建不匹配，更新未完成；没有再次启动进程');
     if(lastStatus.instance===original.instance||lastStatus.shopId!==original.shopId)
      return block('UPGRADE_INSTANCE_CHANGED','新版后台实例或店铺身份未通过核对，更新未完成');
     if(!resumeOnLaunch||lastStatus.running===true){this.blocked=null;this.resumeIntent=null;return{state:'upgraded',status:lastStatus,upgrade:emit('ready',resumeOnLaunch?'新版后台已运行，守护已恢复':'新版后台已运行，守护保持暂停')};}
     emit('resuming','新版后台已运行，正在连接原店铺并恢复守护');
    }
    await sleep(pollMs);
   }
   return block('UPGRADE_START_TIMEOUT','新版后台尚未完成连接或恢复守护，请查看更新记录；未重复启动');
  };
  try{
   for(;;){
    if(!shouldContinue())return cancelled();
    let p;
    try{p=await probe({url,shopId});connectionFailedAt=null;}
    catch(error){
     if(connectionFailedAt===null)connectionFailedAt=now();
     if(now()-began>=timeoutMs||now()-connectionFailedAt>=Math.min(30000,timeoutMs))return block('UPGRADE_CONNECTION_UNCERTAIN','旧后台连接无法核实，未关闭进程或启动第二个实例：'+error.message);
     emit('checking','正在重新核对旧后台连接，保留现有进程');await sleep(pollMs);continue;
    }
    if(p.state==='absent')return original&&shutdown?await launch():{state:'absent'};
    lastStatus=p.status;
    if(lastStatus.sourceBuild===expectedBuild&&(!expectedVersion||lastStatus.version===expectedVersion)){
     this.blocked=null;return{state:'current',status:lastStatus,upgrade:emit('ready','桌面与实际后台版本、构建一致')};
    }
    if(!original){
     original=structuredClone(lastStatus);
     // A failed launch or ambiguous termination must not become a fresh
     // replacement attempt on every five-second desktop refresh.
     const automaticRetry=new Set(['UPGRADE_PENDING_SUBMISSIONS','UPGRADE_BUSY','UPGRADE_STATE_UNPROVEN']);
     if(this.blocked?.expectedBuild===expectedBuild&&!automaticRetry.has(this.blocked.state.code)){
      this.state={...this.blocked.state,actualVersion:lastStatus.version,actualBuild:lastStatus.sourceBuild};onState(this.state);
      return{state:'blocked',code:this.state.code,status:lastStatus,upgrade:this.state};
     }
     if(this.resumeIntent?.instance!==original.instance||this.resumeIntent.expectedBuild!==expectedBuild)
      this.resumeIntent={instance:original.instance,expectedBuild,wasRunning:original.running===true};
     resumeOnLaunch=this.resumeIntent.wasRunning;
     if(this.blocked?.instance===original.instance&&this.blocked.expectedBuild===expectedBuild&&
      (original.busy||original.action||pending(original))){this.state=this.blocked.state;onState(this.state);return{state:'blocked',code:this.state.code,status:lastStatus,upgrade:this.state};}
     emit('checking','新版已安装，正在核对实际运行的旧后台');
    }else if(!same(original,lastStatus))return block('UPGRADE_INSTANCE_CHANGED','等待期间后台实例或店铺已变化，已停止自动接管');
    if(stopped&&lastStatus.running!==false)return block('UPGRADE_STOP_REVOKED','旧后台在停止确认后重新运行，已停止自动接管，请核对当前操作');
    progress.observe(lastStatus,now());
    if(shutdown){
     if(now()-shutdownAt>=shutdownWaitMs)return block('UPGRADE_SHUTDOWN_TIMEOUT','旧后台退出尚未确认，未启动新版；请查看更新记录');
     emit('stopping','正在确认旧后台及其专用浏览器退出');await sleep(pollMs);continue;
    }
    if(pending(lastStatus)){
     emit('waiting-results','存在未完成任务或待核实提交，等待原后台处理；不会强行接管或重复提交');
     if(now()-began>=timeoutMs)return block('UPGRADE_PENDING_SUBMISSIONS','等待已达上限，仍有未完成任务或待核实提交；保留旧后台、数据库和任务，请核实后重试更新');
    }else if(lastStatus.loginOpen||lastStatus.action&&!readonly(lastStatus)){
     emit('waiting-task','等待当前登录或店铺操作安全完成');
     if(now()-began>=timeoutMs)return block('UPGRADE_BUSY','等待当前操作已达上限，自动接管条件不足；请完成当前操作后重试');
    }else if(!lastStatus.busy&&!lastStatus.action){
     emit('stopping','当前工作已完成，正在安全关闭旧后台');
     await control({url,shopId:original.shopId,expectedInstance:original.instance,path:'shutdown',args:{resumeOnLaunch}});
     shutdown=true;shutdownAt=now();
    }else if(readonly(lastStatus)){
     if(!stopped){
      emit('pausing','正在暂停旧后台新一轮巡检，等待当前读取收尾');
      const ack=await control({url,shopId:original.shopId,expectedInstance:original.instance,path:'stop',args:{forUpgrade:true,expectedInstance:original.instance}});
      if(ack?.ok!==true||ack.running!==false||!same(original,ack))return block('UPGRADE_STOP_UNCONFIRMED','未收到同一旧后台停止写入的确认，未进行强制接管');
      stopped=true;lastStatus=ack;
     }
     const stalled=now()-progress.at>=stallMs,expired=now()-began>=timeoutMs;
     emit(stalled?'stalled':'draining',stalled?'旧后台读取无实质进展，正在检查安全接管条件':'旧后台已暂停新任务，正在等待当前读取收尾');
     if(stalled||expired){
      if(forceAttempted||!takeover)return block('UPGRADE_TAKEOVER_UNAVAILABLE','旧后台读取停滞或等待已达上限，尚无法安全接管；任务和数据库已保留');
      forceAttempted=true;
      if(!shouldContinue())return cancelled();
      emit('taking-over','正在核对完整任务、备份数据库并安全关闭停滞的旧后台');
      const proof=await takeover({original,status:lastStatus,resumeOnLaunch,shouldContinue});
      if(proof?.ok!==true||proof.state!=='stopped'||proof.recordsPreserved!==true)return block('UPGRADE_TAKEOVER_UNCONFIRMED','安全接管未完成核验，未启动新版后台');
      shutdown=true;shutdownAt=now();
     }
    }else{
     emit('waiting-task','旧后台正在执行工作，当前状态不足以证明可以安全接管');
     if(now()-began>=timeoutMs)return block('UPGRADE_STATE_UNPROVEN','等待已达上限，不能证明旧后台仅在读取；未强行关闭或重复提交');
    }
    await sleep(pollMs);
   }
  }catch(error){if(!shouldContinue())return cancelled();return block(error.code||'UPGRADE_FAILED','后台更新未完成，任务和数据库保留：'+error.message);}
 }
}
