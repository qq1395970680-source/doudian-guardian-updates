import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {wakeVerification,verificationSummary} from '../src/verification-schedule.mjs';
import {careServiceFixture} from './helpers/care-service-fixture.mjs';

test('persistent unknown readbacks cannot consume all recovery work, rotate fairly and survive restart backoff',async()=>{
 const journal=new Journal(':memory:');try{
  const f=careServiceFixture(journal);for(let i=0;i<2;i++){const baseline={...structuredClone(f.baseline),productId:'350000000000000009'+i};journal.remember(baseline,f.now());journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('unknown-'+i,f.policy.shopId,'unknown-'+i,'unknown',JSON.stringify({plans:[{...baseline,shopId:f.policy.shopId}],submitAttempts:1,riskAttempts:i}),f.now()-1000+i);}
  let service=new GuardianService({journal,...f});await service.tick();assert.equal(f.state.reads.filter(id=>id.startsWith('unknown')).length,1);assert.equal(f.state.submits,1,'normal price recovery must progress after one old unknown readback');
  await service.tick();assert.deepEqual(new Set(f.state.reads.filter(id=>id.startsWith('unknown'))),new Set(['unknown-0','unknown-1']));const before=f.state.reads.length;
  service=new GuardianService({journal,...f});await service.tick();assert.equal(f.state.reads.length,before,'restart must preserve next readback time');assert.equal(f.state.submits,1);
  const schedule=verificationSummary(journal,f.policy.shopId);assert.equal(schedule.pending,2);assert.ok(schedule.entries.every(e=>e.nextAt>f.now()));
  f.advance(30000);await service.tick();assert.equal(f.state.reads.filter(id=>id==='unknown-0').length,2);assert.equal(journal.get('unknown-0').submitAttempts,1);assert.equal(journal.get('unknown-0').riskAttempts,0);assert.equal(journal.get('unknown-1').submitAttempts,1);assert.equal(journal.get('unknown-1').riskAttempts,1);
  const freshService=new GuardianService({journal,...f});wakeVerification(journal,f.policy.shopId,['unknown-1'],f.now());await freshService.tick();assert.equal(f.state.reads.filter(id=>id==='unknown-1').length,2);
 }finally{journal.close();}
});

test('phase or task evidence changes wake a scheduled unknown without allowing any new submit',async()=>{
 const journal=new Journal(':memory:');try{const f=careServiceFixture(journal),body={plans:[{...f.baseline,productId:'3500000000000000099'}],submitAttempts:1,riskAttempts:1};journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('unknown-change',f.policy.shopId,'unknown-change','unknown',JSON.stringify(body),f.now());let service=new GuardianService({journal,...f});await service.tick();const before=f.state.reads.filter(id=>id==='unknown-change').length;journal.db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(f.now()+1,'unknown-change');f.advance(1);service=new GuardianService({journal,...f});await service.tick();assert.equal(f.state.reads.filter(id=>id==='unknown-change').length,before+1);assert.equal(journal.get('unknown-change').submitAttempts,1);}finally{journal.close();}
});
