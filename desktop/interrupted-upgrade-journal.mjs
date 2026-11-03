import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Journal} from '../src/journal.mjs';
import {fingerprint,requireThat} from '../src/policy.mjs';
import {probeService} from './service-controller.mjs';

const observation=/^(campaign:|campaign-attempt:|catalog-view:|priority-watch:|patrol-display:|preview:)/;
const open=path=>new DatabaseSync(path,{readOnly:true,timeout:3000});
const rows=(db,table)=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
function snapshot(db){
 requireThat(db.prepare('PRAGMA quick_check').get().quick_check==='ok','UPGRADE_DATABASE_INVALID','数据库完整性检查未通过');
 const tasks=rows(db,'tasks'),protectedTables=['price_reviews','price_targets','baselines','product_checks'].map(table=>({table,rows:rows(db,table)}));
 const settings=rows(db,'settings').filter(r=>!observation.test(r.shop));
 return{tasks,protectedFingerprint:fingerprint({protectedTables,settings}),application:JSON.parse(settings.find(r=>r.shop==='application')?.body||'{}')};
}
const knownZero=t=>t.submitAttempts===0&&t.riskAttempts===0&&t.submittedAt==null&&t.riskAttemptedAt==null&&t.draftProof==null&&t.riskProof==null&&t.receipt==null;
function expectedRecovery(row,now){
 const body=JSON.parse(row.body),result={...row,body};
 if(['submitting','verifying'].includes(row.phase)){result.phase='unknown';body.reason='process-restarted-readback-only';result.updated=now;}
 else if(['queued','prepared'].includes(row.phase)||row.phase==='blocked'&&body.reason==='pre-submit-proof-expired-on-restart'&&body.retryAfter==null){
  const safe=knownZero(body);result.phase=safe?'blocked':'unknown';body.reason=safe?'pre-submit-proof-expired-on-restart':'restart-submit-boundary-unconfirmed-readback-only';if(safe)body.retryAfter=now;result.updated=now;
 }
 return result;
}
export function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
function validateExpected(expected){
 requireThat(expected&&Number.isInteger(expected.pid)&&expected.pid>0&&expected.pid!==process.pid&&typeof expected.instance==='string'&&expected.instance.length>0&&/^[a-f0-9]{64}$/.test(expected.sourceBuild||'')&&Number.isFinite(expected.startedAt)&&expected.startedAt>0,'UPGRADE_IDENTITY_INVALID','缺少旧后台的完整进程身份');
 requireThat(Array.isArray(expected.processIds)&&expected.processIds.includes(expected.pid)&&expected.processIds.every(pid=>Number.isInteger(pid)&&pid>0&&pid!==process.pid)&&new Set(expected.processIds).size===expected.processIds.length,'UPGRADE_IDENTITY_INVALID','缺少已核对的旧后台及专用浏览器身份');
 const url=new URL(expected.url);requireThat(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&(!expected.shopId||/^\d{3,25}$/.test(expected.shopId)),'UPGRADE_IDENTITY_INVALID','后台地址或店铺无效');
}
async function saveBackup(db,path){
 const until=Date.now()+20000;await backup(db,path,{rate:512,progress:()=>{requireThat(Date.now()<until,'UPGRADE_BACKUP_TIMEOUT','一致备份超时，未启动新版');}});
 const copy=open(path);try{return snapshot(copy);}finally{copy.close();}
}
// This helper runs in the bundled Node, after the desktop has stopped dispatch.
// The old worker may still finish ONE previously recorded click at checkpoint;
// only the independently verified post-exit DB is used for recovery decisions.
export async function interruptedUpgradeJournal({runtime,mode,cutoverId,expected},{isAlive=processAlive,probe=probeService,now=Date.now}={}){
 runtime=resolve(runtime);validateExpected(expected);requireThat(['interrupt-checkpoint','interrupt-finalize'].includes(mode),'UPGRADE_MODE_INVALID','未知任务切换模式无效');
 const directory=join(runtime,'updates','backups');await mkdir(directory,{recursive:true});
 const path=join(runtime,'guardian.sqlite');
 if(mode==='interrupt-checkpoint'){
  cutoverId=randomUUID();const db=open(path);try{
   const saved=await saveBackup(db,join(directory,'interrupt-'+cutoverId+'-before.sqlite'));
   requireThat((saved.application.selected??null)===expected.shopId,'SHOP_MISMATCH','数据库当前店铺与旧后台不一致');
   const record={schema:1,cutoverId,source:'owned-active-upgrade',expected,at:now(),beforeTasksFingerprint:fingerprint(saved.tasks)};
   await writeFile(join(directory,'interrupt-'+cutoverId+'.json'),JSON.stringify(record),'utf8');
   return{source:record.source,complete:true,cutoverId,totalTasks:saved.tasks.length,pendingTasks:saved.tasks.filter(t=>!['verified','blocked'].includes(t.phase)).length,checkpointSaved:true};
  }finally{db.close();}
 }
 requireThat(/^[a-f0-9-]{36}$/.test(cutoverId||''),'UPGRADE_CHECKPOINT_INVALID','缺少本次切换备份标识');
 const recordPath=join(directory,'interrupt-'+cutoverId+'.json'),record=JSON.parse(await readFile(recordPath,'utf8'));
 requireThat(record.schema===1&&record.source==='owned-active-upgrade'&&record.cutoverId===cutoverId&&fingerprint(record.expected)===fingerprint(expected),'UPGRADE_CHECKPOINT_INVALID','切换备份与旧后台身份不一致');
 requireThat(!expected.processIds.some(pid=>isAlive(pid)),'UPGRADE_PROCESS_ALIVE','旧后台或专用浏览器进程仍在，不写任务或启动新版');
 requireThat((await probe({url:expected.url,shopId:expected.shopId})).state==='absent','UPGRADE_PORT_OCCUPIED','旧后台端口尚未确认退出');
 const finalPath=join(directory,'interrupt-'+cutoverId+'-final.sqlite');
 let before;try{await access(finalPath);const saved=open(finalPath);try{before=snapshot(saved);}finally{saved.close();}}
 catch(error){if(error.code!=='ENOENT')throw error;const db=open(path);try{before=await saveBackup(db,finalPath);}finally{db.close();}}
 requireThat((before.application.selected??null)===expected.shopId,'SHOP_MISMATCH','退出后的数据库店铺发生变化');
 const at=record.normalizationAt||now();if(!record.normalizationAt){record.normalizationAt=at;await writeFile(recordPath,JSON.stringify(record),'utf8');}
 const journal=new Journal(path);
 try{
  // A previous interrupted finalize may have completed some rows. Every row
  // must still be either its original or exact independently predicted state.
  const current=snapshot(journal.db),original=new Map(before.tasks.map(r=>[r.id,r]));
  requireThat(current.tasks.length===before.tasks.length&&current.protectedFingerprint===before.protectedFingerprint,'UPGRADE_DATA_CHANGED','价格、历史、下架证明、授权或任务集合变化，未启动新版');
  for(const row of current.tasks){const old=original.get(row.id),material={...row,body:JSON.parse(row.body)};requireThat(old&&(fingerprint(material)===fingerprint({...old,body:JSON.parse(old.body)})||fingerprint(material)===fingerprint(expectedRecovery(old,at))),'UPGRADE_TASK_CHANGED','任务计数、价格计划或提交证据变化，未启动新版');}
  // HTTP and PID are checked again immediately before the first mutation.
  requireThat(!expected.processIds.some(pid=>isAlive(pid))&&(await probe({url:expected.url,shopId:expected.shopId})).state==='absent','UPGRADE_PROCESS_ALIVE','写入恢复记录前发现旧实例、专用浏览器或其他后台');
  for(const shop of new Set(before.tasks.map(r=>r.shop)))journal.recoverInterrupted(shop,at);
  const after=snapshot(journal.db);
  requireThat(after.protectedFingerprint===before.protectedFingerprint&&after.tasks.length===before.tasks.length&&after.tasks.every(row=>fingerprint({...row,body:JSON.parse(row.body)})===fingerprint(expectedRecovery(original.get(row.id),at))),'UPGRADE_RECOVERY_CHANGED','恢复记录超出精确允许的重启状态变化');
  // Only this worker's selected-shop execution lease can be retired after
  // its owned process is gone. Unknown product locks remain in tasks.
  if(expected.shopId)journal.db.prepare('DELETE FROM leases WHERE shop=?').run(expected.shopId);
  const result={source:'owned-active-upgrade',complete:true,cutoverId,recordsPreserved:true,tasksCheckpointed:true,oldProcessExited:true,totalTasks:after.tasks.length,
   unknown:after.tasks.filter(t=>t.phase==='unknown').length,unsubmitted:before.tasks.filter(t=>['queued','prepared'].includes(t.phase)&&knownZero(JSON.parse(t.body))).length,
   finalBackupPath:finalPath,taskFingerprint:fingerprint(after.tasks),protectedFingerprint:after.protectedFingerprint};
  journal.event(null,'active-upgrade-records-preserved',{shopId:expected.shopId,instance:expected.instance,sourceBuild:expected.sourceBuild,cutoverId,unknown:result.unknown,unsubmitted:result.unsubmitted},at);
  await writeFile(join(directory,'interrupt-'+cutoverId+'-verified.json'),JSON.stringify(result),'utf8');return result;
 }finally{journal.close();}
}
