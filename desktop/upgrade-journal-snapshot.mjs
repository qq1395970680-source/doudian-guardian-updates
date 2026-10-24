import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observations=/^(campaign:|campaign-attempt:|catalog-view:|priority-watch:|patrol-display:|preview:)/;
function inspect(db){
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('数据库完整性检查未通过');
 const tasks=db.prepare('SELECT id,shop,phase,body FROM tasks ORDER BY id').all();
 // Read the entire table, including other stores and rows beyond the UI's 100.
 const pendingTasks=tasks.filter(t=>!['verified','blocked'].includes(t.phase)).length;
 const reviews=db.prepare('SELECT * FROM price_reviews ORDER BY id').all();
 const targets=db.prepare('SELECT * FROM price_targets ORDER BY shop,product').all();
 const settings=db.prepare('SELECT * FROM settings ORDER BY shop').all().filter(r=>!observations.test(r.shop));
 const application=JSON.parse(settings.find(r=>r.shop==='application')?.body||'{}');
 const histories=db.prepare('SELECT * FROM baselines ORDER BY shop,product,hash').all();
 return{proof:{source:'complete-readonly-upgrade-journal',complete:true,capturedAt:Date.now(),selectedShopId:application.selected??null,totalTasks:tasks.length,pendingTasks,
  taskFingerprint:hash(tasks),protectedFingerprint:hash({tasks,reviews,targets,settings}),historyCount:histories.length,
  historyFingerprint:hash(histories)},histories};
}
const open=path=>new DatabaseSync(path,{readOnly:true,timeout:1000});
export async function upgradeJournalSnapshot({runtime,mode,backupId}){
 runtime=resolve(runtime);if(!['inspect','backup','verify'].includes(mode))throw Error('数据库维护模式无效');
 const db=open(join(runtime,'guardian.sqlite'));
 try{
  const current=inspect(db);if(mode==='inspect')return current.proof;
  if(current.proof.pendingTasks!==0)throw Error('完整数据库仍有未完成或未知任务，未进行接管');
  const directory=join(runtime,'updates','backups');
  if(mode==='backup'){
   backupId=randomUUID();await mkdir(directory,{recursive:true});const path=join(directory,'backend-'+backupId+'.sqlite');
   const until=Date.now()+20000;
   await backup(db,path,{rate:512,progress:()=>{if(Date.now()>until)throw Error('数据库备份超时，未进行接管');}});
   const saved=open(path);let copy;try{copy=inspect(saved);}finally{saved.close();}
   const latest=inspect(db);
   if(copy.proof.pendingTasks!==0||copy.proof.protectedFingerprint!==latest.proof.protectedFingerprint)throw Error('备份期间任务或价格确认发生变化，未进行接管');
   return{...copy.proof,backupId,backupPath:path};
  }
  if(!/^[a-f0-9-]{36}$/.test(backupId||''))throw Error('备份标识无效');
  const saved=open(join(directory,'backend-'+backupId+'.sqlite'));let copy;try{copy=inspect(saved);}finally{saved.close();}
  if(copy.proof.protectedFingerprint!==current.proof.protectedFingerprint)throw Error('任务、价格确认或授权设置与接管前备份不一致');
  const rows=new Set(current.histories.map(hash));
  if(copy.histories.some(row=>!rows.has(hash(row))))throw Error('完整历史与接管前备份不一致');
  return{...current.proof,backupId,recordsPreserved:true};
 }finally{db.close();}
}
