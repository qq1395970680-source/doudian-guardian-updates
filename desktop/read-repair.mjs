import {readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {validateBundle} from './backend.mjs';
import {probeService,postControl} from './service-controller.mjs';
import {isReadonlyStage} from './readonly-stage.mjs';

export function assertReadonlyRepair(status,{journalProof}={}){
 if(journalProof?.pendingTasks>0)throw Object.assign(Error('完整数据库仍有 '+journalProof.pendingTasks+' 个未完成或未知任务，保留旧后台及待核实提交'),{code:'UPGRADE_PENDING_SUBMISSIONS'});
 const complete=journalProof?.source==='complete-readonly-upgrade-journal'&&journalProof.complete===true&&journalProof.pendingTasks===0&&
  Number.isInteger(journalProof.totalTasks)&&journalProof.totalTasks>=status.tasks?.length&&/^[a-f0-9]{64}$/.test(journalProof.taskFingerprint||'');
 if(status.unknown!==0||status.loginOpen||!Array.isArray(status.tasks)||journalProof&&!complete||status.tasks.length>=100&&!complete||
   status.tasks.some(t=>!['verified','blocked'].includes(t.phase))||
   status.action&&!['连接店铺','同步当前折扣','连接店铺并同步折扣'].includes(status.action)||
   !isReadonlyStage(status.progress?.stage))throw Error('当前状态不能证明仅有只读工作；保留后台及待核实提交。');
}
const same=(a,b)=>a.instance===b.instance&&a.sourceBuild===b.sourceBuild&&a.shopId===b.shopId&&a.startedAt===b.startedAt;
// Used by the explicit repair action or the bounded desktop upgrade. A fresh
// stop acknowledgement is essential even when the old read await is stuck.
export async function repairReadonlyService({url,runtime,probe=probeService,control=postControl,inspect,terminate,start,
 readRecord=async()=>JSON.parse(await readFile(join(runtime,'service-status.json'),'utf8')),validate=validateBundle,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,
 journalCheck=null,launchAfterRepair=true,shouldContinue=()=>true,expectedInstance}){
 const first=await probe({url});if(first.state!=='ready')throw Error('旧后台未连接，无法核对只读状态');
 const original=first.status;
 if(expectedInstance&&original.instance!==expectedInstance)throw Error('待接管的旧后台实例已变化');
 const initialJournal=journalCheck?await journalCheck('inspect'):null;assertReadonlyRepair(original,{journalProof:initialJournal});
 const record=await readRecord();
 const shopMatches=record.shopId===original.shopId||initialJournal?.selectedShopId===original.shopId;
 if(record.url!==url||record.sourceBuild!==original.sourceBuild||!shopMatches||!Number.isInteger(record.pid)||
   !Number.isFinite(record.startedAt)||Math.abs(record.startedAt-original.startedAt)>60000)throw Error('本机后台身份记录不匹配，未关闭任何进程');
 const root=resolve(record.sourceRoot),inside=relative(join(resolve(runtime),'versions'),root);
 if(!inside||inside.startsWith('..')||isAbsolute(inside))throw Error('后台代码不在本程序管理的版本目录，未关闭进程');
 await validate(root);
 const info=JSON.parse(await readFile(join(root,'bundle-info.json'),'utf8'));
 if(info.sourceBuild!==original.sourceBuild)throw Error('后台文件与正在运行的构建不同，未关闭任何进程');
 const expected={pid:record.pid,exe:join(root,'engine','node.exe'),startedAt:original.startedAt,sourceRoot:root,runtime:resolve(runtime)};
 const identity=await inspect(expected);
 if(!shouldContinue())throw Error('后台更新已取消');
 const ack=await control({url,path:'stop',expectedInstance:original.instance});
 const stoppedJournal=journalCheck?await journalCheck('inspect'):null;assertReadonlyRepair(ack,{journalProof:stoppedJournal});
 if(ack.ok!==true||ack.running!==false||!same(original,ack))throw Error('未收到同一实例的停止写入确认，保留旧后台');
 // Give the new bounded reader a chance to exit normally; the legacy reader
 // may remain busy. Either route requires a second, fresh stop-state check.
 await sleep(750);const after=await probe({url});
 if(after.state!=='ready'||!same(original,after.status)||after.status.running!==false)throw Error('停止后后台实例或运行状态变化，未进行进程维护');
 const backup=journalCheck?await journalCheck('backup'):null;
 const freshJournal=journalCheck?await journalCheck('verify',backup.backupId):null;
 assertReadonlyRepair(after.status,{journalProof:freshJournal});
 if(!shouldContinue())throw Error('后台更新已取消');
 // Re-probe after the potentially lengthy backup and immediately before the
 // native helper rechecks every process identity and closes the owned tree.
 const final=await probe({url});
 if(final.state!=='ready'||!same(original,final.status)||final.status.running!==false)throw Error('备份后后台身份或停止状态变化，取消接管');
 assertReadonlyRepair(final.status,{journalProof:freshJournal});
 const closed=await terminate(expected,identity);
 if(journalCheck&&closed?.closed!==true)throw Error('进程退出未确认，未启动新版');
 const deadline=now()+10000;
 while(now()<deadline){
  const gone=await probe({url});if(gone.state==='absent'){
   const preserved=journalCheck?await journalCheck('verify',backup.backupId):null;
   if(!shouldContinue())throw Error('后台更新已取消');
   if(launchAfterRepair)await start();
   return{ok:true,state:launchAfterRepair?'restarted':'stopped',resumeRequired:true,...(preserved?{recordsPreserved:preserved.recordsPreserved,backupId:backup.backupId,backupPath:backup.backupPath}:{})};
  }
  if(gone.state==='ready'&&!same(original,gone.status))throw Error('端口出现另一实例，未启动第二个后台');
  await sleep(250);
 }
 throw Error('旧后台尚未确认退出，未启动新版');
}
