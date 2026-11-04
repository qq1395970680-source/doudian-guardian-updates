import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/journal.mjs';
import {interruptedUpgradeJournal} from '../desktop/interrupted-upgrade-journal.mjs';
import {fingerprint} from '../src/policy.mjs';

async function fixture(t){const runtime=await mkdtemp(join(tmpdir(),'guardian-active-journal-')),j=new Journal(join(runtime,'guardian.sqlite')),at=Date.now(),expected={pid:123456789,processIds:[123456789,123456788],instance:'fixture-owned-instance',sourceBuild:'a'.repeat(64),startedAt:at-10000,shopId:'900001',url:'http://127.0.0.1:19001',sourceRoot:join(runtime,'versions','old'),runtime};
 t.after(async()=>{j.close();await rm(runtime,{recursive:true,force:true});});j.putSettings('application',{selected:'900001',accounts:[{shopId:'900001',originalRiskAllowed:true}]});j.putSettings('campaign-conversion:900001',{status:'cancelling',cancelAttempts:1,confirmAttempts:0});j.putSettings('dual-activity-care-policy:900001',{enabled:true,grantId:'do-not-replace'});
 const add=(id,phase,body,shop='900001')=>j.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,shop,id,phase,JSON.stringify({title:'immutable-'+id,plans:[{productId:'800001',priceApprovalId:'keep',skus:[{saleFen:6532}]}],lossEvidence:{complete:true},...body}),1);
 for(let i=0;i<105;i++)add('verified-'+i,'verified',{submitAttempts:1,riskAttempts:1,receipt:{campaignId:'400009'}});
 add('queued','queued',{submitAttempts:0,riskAttempts:0});add('prepared','prepared',{submitAttempts:0,riskAttempts:0,preparedAt:1});add('submitting','submitting',{submitAttempts:1,riskAttempts:0,submittedAt:2,draftProof:{materialFingerprint:'keep'}});add('verifying','verifying',{submitAttempts:1,riskAttempts:1,riskProof:{at:3}});add('unknown','unknown',{submitAttempts:1,riskAttempts:0,reason:'keep old unknown'},'900002');add('contradictory','prepared',{submitAttempts:0,riskAttempts:0,draftProof:{at:2}});add('missing','queued',{submitAttempts:0});j.db.prepare('INSERT INTO leases VALUES(?,?,?)').run('900001','old-owner',at+60000);j.db.prepare('INSERT INTO leases VALUES(?,?,?)').run('900002','other-owner',at+60000);
 return{j,runtime,expected,at,deps:{isAlive:()=>false,probe:async()=>({state:'absent'}),now:()=>at}};
}
test('all shops and more than 100 tasks preserve exact prices/counters/proofs; only safe restart states and the old selected-shop lease change',async t=>{
 const f=await fixture(t),before=f.j.list('900001'),other=f.j.get('unknown'),settings=f.j.settings('campaign-conversion:900001'),checkpoint=await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,mode:'interrupt-checkpoint'},f.deps);assert.ok(checkpoint.pendingTasks>=7);
 const proof=await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps);assert.equal(proof.recordsPreserved,true);assert.equal(proof.totalTasks,112);assert.equal(proof.unknown,5);assert.equal(proof.unsubmitted,2);assert.deepEqual(f.j.get('unknown'),other);
 for(const old of before){const current=f.j.get(old.id);assert.deepEqual(current.plans,old.plans);for(const key of ['submitAttempts','riskAttempts','submittedAt','riskAttemptedAt','draftProof','riskProof','receipt'])assert.deepEqual(current[key],old[key]);}
 assert.equal(f.j.get('queued').phase,'blocked');assert.equal(f.j.get('prepared').phase,'blocked');assert.equal(f.j.get('queued').retryAfter,f.at);assert.equal(f.j.get('missing').phase,'unknown');assert.equal(f.j.get('missing').riskAttempts,undefined);assert.equal(f.j.get('contradictory').phase,'unknown');assert.deepEqual(f.j.settings('campaign-conversion:900001'),settings);assert.equal(f.j.settings('dual-activity-care-policy:900001').grantId,'do-not-replace');assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM leases WHERE shop=?').get('900001').n,0);assert.equal(f.j.db.prepare('SELECT COUNT(*) n FROM leases WHERE shop=?').get('900002').n,1);assert.ok((await readFile(proof.finalBackupPath)).length>0);
 const taskHash=fingerprint(f.j.list('900001'));await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps);assert.equal(fingerprint(f.j.list('900001')),taskHash,'finalize retry is idempotent before launch');
});
for(const failure of ['pid-alive','port-alive','different-instance'])test('no offline task write without exact checkpoint identity and BOTH exit proofs: '+failure,async t=>{
 const f=await fixture(t),checkpoint=await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,mode:'interrupt-checkpoint'},f.deps),before=fingerprint(f.j.list('900001'));
 const deps={...f.deps,...(failure==='pid-alive'?{isAlive:()=>true}:failure==='port-alive'?{probe:async()=>({state:'ready'})}:{})},expected=failure==='different-instance'?{...f.expected,instance:'other'}:f.expected;
 await assert.rejects(interruptedUpgradeJournal({runtime:f.runtime,expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},deps));assert.equal(fingerprint(f.j.list('900001')),before);
});
test('post-exit data changed since the final snapshot is rejected rather than restoring an old database over it',async t=>{
 const f=await fixture(t),checkpoint=await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,mode:'interrupt-checkpoint'},f.deps);await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps);f.j.putSettings('campaign-conversion:900001',{status:'cancel-unknown',cancelAttempts:1,confirmAttempts:1});
 await assert.rejects(interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps),/授权或任务集合变化/);assert.equal(f.j.settings('campaign-conversion:900001').confirmAttempts,1);
});

test('restart preserves historical-unknown archives and the once-only successor boundary',async t=>{
 const f=await fixture(t);
 f.j.db.prepare('INSERT INTO submission_archives VALUES(?,?,?,?,?,?,?,?)').run('archive-proof','900002','unknown','{"originalSql":"immutable"}','original-fingerprint','{"historicalOutcome":"unknown","success":false}','cycle-key',f.at-1);
 f.j.db.prepare('INSERT INTO submission_successors VALUES(?,?,?,?,?)').run('archive-proof','submitting','plans-fingerprint',f.at-1,f.at-1);
 const before=JSON.stringify({archives:f.j.db.prepare('SELECT * FROM submission_archives').all(),successors:f.j.db.prepare('SELECT * FROM submission_successors').all()});
 const checkpoint=await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,mode:'interrupt-checkpoint'},f.deps);
 await interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps);
 assert.equal(JSON.stringify({archives:f.j.db.prepare('SELECT * FROM submission_archives').all(),successors:f.j.db.prepare('SELECT * FROM submission_successors').all()}),before);
 f.j.db.prepare('UPDATE submission_successors SET submitted_at=? WHERE closure=?').run(f.at,'archive-proof');
 await assert.rejects(interruptedUpgradeJournal({runtime:f.runtime,expected:f.expected,cutoverId:checkpoint.cutoverId,mode:'interrupt-finalize'},f.deps),{code:'UPGRADE_DATA_CHANGED'});
});
