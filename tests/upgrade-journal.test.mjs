import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/journal.mjs';
import {upgradeJournalSnapshot} from '../desktop/upgrade-journal-snapshot.mjs';
import {assertReadonlyRepair} from '../desktop/read-repair.mjs';

async function fixture(t){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-upgrade-journal-')),journal=new Journal(join(runtime,'guardian.sqlite'));
 t.after(async()=>{journal.close();await rm(runtime,{recursive:true,force:true});});
 const insert=journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)');
 for(let i=0;i<105;i++)insert.run('task-'+i,'900001','dedupe-'+i,'verified',JSON.stringify({plans:[],submitAttempts:1,riskAttempts:0}),i+1);
 journal.putSettings('application',{selected:'900001',accounts:[{shopId:'900001',originalRiskAllowed:true}]});
 journal.putSettings('900001',{executionEnabled:true,autoStart:false});
 journal.db.prepare('INSERT INTO baselines VALUES(?,?,?,?,?)').run('900001','800001','history',1,'{"complete":true,"skus":[{"saleFen":6532}]}');
 journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run('approved','900001','800001','approved','{"saleFen":6532,"approved":true}',1);
 journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run('900001','800001','approved');
 return{runtime,journal};
}
const status={unknown:0,loginOpen:false,action:null,progress:{stage:'核对当前活动'},tasks:Array.from({length:100},()=>({phase:'verified'}))};
test('full SQLite proof supports 105 historical tasks without truncating or changing any task or approval',async t=>{
 const {runtime}=await fixture(t),before=await upgradeJournalSnapshot({runtime,mode:'inspect'});
 assert.equal(before.totalTasks,105);assert.equal(before.pendingTasks,0);assert.doesNotThrow(()=>assertReadonlyRepair(status,{journalProof:before}));
 const backup=await upgradeJournalSnapshot({runtime,mode:'backup'}),after=await upgradeJournalSnapshot({runtime,mode:'verify',backupId:backup.backupId});
 assert.equal(after.recordsPreserved,true);assert.equal(before.protectedFingerprint,after.protectedFingerprint);assert.equal(before.historyFingerprint,after.historyFingerprint);
});
test('the 105th unknown task is protected even when all 100 visible tasks are verified',async t=>{
 const {runtime,journal}=await fixture(t);journal.db.prepare("UPDATE tasks SET phase='unknown' WHERE id='task-104'").run();
 const proof=await upgradeJournalSnapshot({runtime,mode:'inspect'});assert.equal(proof.pendingTasks,1);
 assert.throws(()=>assertReadonlyRepair(status,{journalProof:proof}));
 assert.throws(()=>assertReadonlyRepair({...status,tasks:[]},{journalProof:proof}));
 await assert.rejects(upgradeJournalSnapshot({runtime,mode:'backup'}),/未完成或未知任务/);
});
for(const kind of ['task','price','history','authorization'])test(`takeover refuses a changed ${kind} after the backup rather than silently restoring or overwriting it`,async t=>{
 const {runtime,journal}=await fixture(t),saved=await upgradeJournalSnapshot({runtime,mode:'backup'});
 if(kind==='task')journal.db.prepare("UPDATE tasks SET body='{}' WHERE id='task-104'").run();
 if(kind==='price')journal.db.prepare("UPDATE price_reviews SET body='{}' WHERE id='approved'").run();
 if(kind==='history')journal.db.prepare('DELETE FROM baselines').run();
 if(kind==='authorization')journal.putSettings('900001',{executionEnabled:false,autoStart:false});
 await assert.rejects(upgradeJournalSnapshot({runtime,mode:'verify',backupId:saved.backupId}));
});
