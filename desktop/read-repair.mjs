import {readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {validateBundle} from './backend.mjs';
import {probeService,postControl} from './service-controller.mjs';

const readonlyStage=/^(读取全店活动列表|核对当前活动|优先核对风险活动|补读完整历史|全店当前活动核对完成|当前活动仍有读取失败，暂停恢复|尚未连接)$/;
export function assertReadonlyRepair(status){
 if(status.unknown!==0||status.loginOpen||!Array.isArray(status.tasks)||status.tasks.length>=100||
   status.tasks.some(t=>!['verified','blocked'].includes(t.phase))||
   status.action&&!['连接店铺','同步当前折扣','连接店铺并同步折扣'].includes(status.action)||
   !readonlyStage.test(status.progress?.stage||''))throw Error('当前状态不能证明仅有只读工作；保留后台及待核实提交。');
}
const same=(a,b)=>a.instance===b.instance&&a.sourceBuild===b.sourceBuild&&a.shopId===b.shopId&&a.startedAt===b.startedAt;
// Invoked only by an explicit desktop/tray action. The stop acknowledgement is
// essential: even an old blocked await must no longer be able to begin a write.
export async function repairReadonlyService({url,runtime,probe=probeService,control=postControl,inspect,terminate,start,
 readRecord=async()=>JSON.parse(await readFile(join(runtime,'service-status.json'),'utf8')),validate=validateBundle,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 const first=await probe({url});if(first.state!=='ready')throw Error('旧后台未连接，无法核对只读状态');
 const original=first.status;assertReadonlyRepair(original);
 const record=await readRecord();
 if(record.url!==url||record.sourceBuild!==original.sourceBuild||record.shopId!==original.shopId||!Number.isInteger(record.pid)||
   !Number.isFinite(record.startedAt)||Math.abs(record.startedAt-original.startedAt)>60000)throw Error('本机后台身份记录不匹配，未关闭任何进程');
 const root=resolve(record.sourceRoot),inside=relative(join(resolve(runtime),'versions'),root);
 if(!inside||inside.startsWith('..')||isAbsolute(inside))throw Error('后台代码不在本程序管理的版本目录，未关闭进程');
 await validate(root);
 const info=JSON.parse(await readFile(join(root,'bundle-info.json'),'utf8'));
 if(info.sourceBuild!==original.sourceBuild)throw Error('后台文件与正在运行的构建不同，未关闭任何进程');
 const expected={pid:record.pid,exe:join(root,'engine','node.exe'),startedAt:original.startedAt,sourceRoot:root,runtime:resolve(runtime)};
 const identity=await inspect(expected);
 const ack=await control({url,path:'stop'});assertReadonlyRepair(ack);
 if(ack.ok!==true||ack.running!==false||!same(original,ack))throw Error('未收到同一实例的停止写入确认，保留旧后台');
 // Give the new bounded reader a chance to exit normally; the legacy reader
 // may remain busy. Either route requires a second, fresh stop-state check.
 await sleep(750);const after=await probe({url});
 if(after.state!=='ready'||!same(original,after.status)||after.status.running!==false)throw Error('停止后后台实例或运行状态变化，未进行进程维护');
 assertReadonlyRepair(after.status);
 await terminate(expected,identity);
 const deadline=now()+10000;
 while(now()<deadline){
  const gone=await probe({url});if(gone.state==='absent'){await start();return{ok:true,state:'restarted',resumeRequired:true};}
  if(gone.state==='ready'&&!same(original,gone.status))throw Error('端口出现另一实例，未启动第二个后台');
  await sleep(250);
 }
 throw Error('旧后台尚未确认退出，未启动新版');
}
