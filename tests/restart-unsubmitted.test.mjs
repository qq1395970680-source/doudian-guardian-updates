import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {fixedNow as now,priceFixture} from './helpers/price-review-fixture.mjs';

for(const phase of ['queued','prepared','old-restart-block'])test(phase+' restarts as a fresh-recheck candidate without replaying its old plan',()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),id=f.task.id;
  if(phase==='prepared')j.transition(id,'queued','prepared',{preparedAt:now},now);
  if(phase==='old-restart-block')j.transition(id,'queued','blocked',{reason:'pre-submit-proof-expired-on-restart'},now);
  const before=j.get(id),plans=fingerprint(before.plans),history=fingerprint(j.histories(f.policy.shopId));
  j.recoverInterrupted(f.policy.shopId,now+60000);const recovered=j.get(id);
  assert.equal(recovered.phase,'blocked','restart never queues stale proof directly');
  assert.equal(recovered.submitAttempts,0);assert.equal(recovered.riskAttempts,0);
  assert.ok(recovered.retryAfter>0&&recovered.retryAfter<=now+60000,'a zero-submit task must not remain permanently ineligible');
  assert.equal(fingerprint(recovered.plans),plans);assert.equal(fingerprint(j.histories(f.policy.shopId)),history);
  assert.equal(j.priceTarget(f.policy.shopId,f.baseline.productId),null);
 }finally{j.close();}
});

test('restart does not clear an unrelated platform or price-consent cooldown',()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),blocked=j.transition(f.task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED: 新价格需要确认',retryAfter:now+900000},now);
  j.recoverInterrupted(f.policy.shopId,now+60000);assert.deepEqual(j.get(blocked.id),blocked);
 }finally{j.close();}
});

for(const phase of ['submitting','verifying','unknown'])test(phase+' remains readback-only after a restart',()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),proof=proveDraft(f.task,{...f.probe,warnings:[],rows:f.probe.rows.map(s=>({...s,errors:[]}))},now);
  j.transition(f.task.id,'queued','prepared',{},now);j.beginSubmit(f.task.id,proof,now);
  if(phase==='verifying')j.transition(f.task.id,'submitting','verifying',{},now);
  if(phase==='unknown')j.transition(f.task.id,'submitting','unknown',{},now);
  j.recoverInterrupted(f.policy.shopId,now+60000);const recovered=j.get(f.task.id);
  assert.equal(recovered.phase,'unknown');assert.equal(recovered.submitAttempts,1);assert.equal(recovered.retryAfter,undefined);
  assert.throws(()=>j.transition(recovered.id,'unknown','queued',{},now+60000),{code:'JOURNAL_TRANSITION'});
 }finally{j.close();}
});

for(const mutation of ['submit-count','risk-count','missing-submit-count','missing-risk-count','string-submit-count','submitted-at','risk-at','submit-proof','risk-proof','receipt'])
test('a contradictory or incomplete submission boundary is retained for readback: '+mutation,()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),body=JSON.parse(j.db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id).body);
  if(mutation==='submit-count')body.submitAttempts=1;
  if(mutation==='risk-count')body.riskAttempts=1;
  if(mutation==='missing-submit-count')delete body.submitAttempts;
  if(mutation==='missing-risk-count')delete body.riskAttempts;
  if(mutation==='string-submit-count')body.submitAttempts='0';
  if(mutation==='submitted-at')body.submittedAt=now;
  if(mutation==='risk-at')body.riskAttemptedAt=now;
  if(mutation==='submit-proof')body.draftProof={taskId:f.task.id,at:now};
  if(mutation==='risk-proof')body.riskProof={taskId:f.task.id,at:now};
  if(mutation==='receipt')body.receipt={campaignId:'4000000000000000002',verifiedAt:now};
  // Fault injection is confined to this in-memory journal, never an import or
  // repair of production data. Every original field must remain intact.
  j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),f.task.id);
  const prior=j.get(f.task.id);j.recoverInterrupted(f.policy.shopId,now+60000);const recovered=j.get(f.task.id);
  assert.equal(recovered.phase,'unknown');assert.equal(recovered.retryAfter,undefined);
  for(const field of ['plans','submitAttempts','riskAttempts','submittedAt','riskAttemptedAt','draftProof','riskProof','receipt'])assert.deepEqual(recovered[field],prior[field]);
  assert.throws(()=>j.transition(recovered.id,'unknown','queued',{},now+60000),{code:'JOURNAL_TRANSITION'});
 }finally{j.close();}
});

for(const mutation of ['risk-attempt','missing-risk-count','submitted-at','draft-proof','receipt'])test('write boundary refuses contradictory pre-submit metadata: '+mutation,()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),proof=proveDraft(f.task,{...f.probe,warnings:[],rows:f.probe.rows.map(s=>({...s,errors:[]}))},now);
  j.transition(f.task.id,'queued','prepared',{},now);
  const body=JSON.parse(j.db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id).body);
  if(mutation==='risk-attempt')body.riskAttempts=1;
  if(mutation==='missing-risk-count')delete body.riskAttempts;
  if(mutation==='submitted-at')body.submittedAt=now;
  if(mutation==='draft-proof')body.draftProof=proof;
  if(mutation==='receipt')body.receipt={campaignId:'4000000000000000002',verifiedAt:now};
  j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),f.task.id);
  assert.throws(()=>j.beginSubmit(f.task.id,proof,now),{code:'SUBMIT_PROOF'});
  j.transition(f.task.id,'prepared','blocked',{reason:'PRICE_REVIEW_REQUIRED',retryAfter:now},now);
  assert.throws(()=>j.transition(f.task.id,'blocked','queued',{},now),{code:'RETRY_FORBIDDEN'});
  assert.equal(j.get(f.task.id).phase,'blocked');assert.equal(j.get(f.task.id).submitAttempts,0);
 }finally{j.close();}
});
