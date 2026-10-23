import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {planOriginalRestore,proveDraft,fingerprint} from '../src/policy.mjs';
import {capacityFixture,capacityNow as now} from './helpers/capacity-fixture.mjs';
import {DoudianPlatform} from '../src/platform.mjs';

const fresh={complete:true,observedAt:now,lossKey:'capacity-direct'};
test('a 501-SKU current product is isolated before task creation while neighboring products recover',async()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j),service=new GuardianService({journal:j,...f,now:()=>now});await service.tick();
  const tasks=j.list(f.policy.shopId),checks=j.productChecks(f.policy.shopId),blocked=checks.find(c=>c.productId===f.baselines[0].productId);
  assert.equal(service.lastRun.ok,true);assert.equal(blocked?.code,'RESTORE_SKU_BUDGET');
  assert.equal(blocked.restoreCapacity.skuCount,501);assert.equal(blocked.restoreCapacity.maxSkus,500);
  assert.match(blocked.message,/501.*500/);assert.ok(tasks.every(t=>!t.plans.some(p=>p.productId===f.baselines[0].productId)));
  assert.equal(tasks.length,1);assert.equal(tasks[0].phase,'verified');assert.equal(tasks[0].plans.length,2);assert.equal(tasks[0].receipt.skuCount,4);
  assert.equal(f.counts.submits,1);assert.equal(j.histories(f.policy.shopId).find(b=>b.productId===f.baselines[0].productId).skus.length,501);
  const reads=f.counts.prechecks.filter(id=>id===f.baselines[0].productId).length;await service.tick();
  assert.equal(f.counts.prechecks.filter(id=>id===f.baselines[0].productId).length,reads,'unchanged oversized work retains its cooldown instead of rereading every patrol');
 }finally{j.close();}
});

test('a permitted 499-SKU current subset is restored without deleting the full 501-SKU history',async()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j,{currentSizes:[499,2,2]}),service=new GuardianService({journal:j,...f,now:()=>now});await service.tick();
  assert.equal(service.lastRun.ok,true,service.lastRun.message);const tasks=j.list(f.policy.shopId),plan=tasks.flatMap(t=>t.plans).find(p=>p.productId===f.baselines[0].productId);
  assert.equal(plan.skus.length,499);assert.deepEqual(plan.skippedSkuIds,f.baselines[0].skus.slice(499).map(s=>s.id));
  assert.ok(tasks.every(t=>t.phase==='verified'&&t.receipt.skuCount<=500));assert.equal(j.histories(f.policy.shopId).find(b=>b.productId===plan.productId).skus.length,501);
 }finally{j.close();}
});

test('the exact 500-SKU boundary still recovers with a complete independent receipt',async()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j,{sizes:[500]}),service=new GuardianService({journal:j,...f,now:()=>now});await service.tick();
  const task=j.list(f.policy.shopId)[0];assert.equal(task.phase,'verified');assert.equal(task.receipt.skuCount,500);assert.equal(f.counts.submits,1);
 }finally{j.close();}
});

test('the platform adapter rejects an oversized direct task before opening or editing a creation page',async()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j,{sizes:[501]}),plan=planOriginalRestore(f.baselines[0],{...f.baselines[0],observedAt:now},f.policy,now);
  const platform=new DoudianPlatform({journal:j,policy:f.policy,browser:{open:async()=>assert.fail('oversized task must not open a browser')}});
  await assert.rejects(()=>platform.prepare({id:'oversized-direct',shopId:f.policy.shopId,plans:[plan]}),{code:'RESTORE_SKU_BUDGET'});
 }finally{j.close();}
});

for(const sizes of [[501],Array(51).fill(1)])test('the durable enqueue boundary rejects an over-budget direct plan: '+sizes.length+' products/'+sizes.reduce((a,b)=>a+b,0)+' SKUs',()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j,{sizes}),plans=f.baselines.map(b=>planOriginalRestore(b,{...b,observedAt:now},f.policy,now));
  assert.throws(()=>j.enqueue(f.policy.shopId,plans,fresh,now),{code:sizes.length>50?'RESTORE_PRODUCT_BUDGET':'RESTORE_SKU_BUDGET'});
  assert.equal(j.list(f.policy.shopId).length,0);
 }finally{j.close();}
});

test('an old zero-submit oversized task cannot cross the main submit boundary, but an old committed result can still be reconciled',async()=>{
 const j=new Journal(':memory:');try{
  const f=capacityFixture(j,{sizes:[501]}),b=f.baselines[0],full=planOriginalRestore(b,{...b,observedAt:now},f.policy,now);
  const small=planOriginalRestore(b,{...b,observedAt:now,skus:b.skus.slice(0,1)},f.policy,now),task=j.enqueue(f.policy.shopId,[small],fresh,now);
  // Simulate a persisted older-program task only in this test database. No
  // diagnostic is imported and no production task or approval is modified.
  const {id,shopId,phase,updatedAt,...body}=j.get(task.id);body.plans=[full];
  j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),id);j.transition(id,'queued','prepared',{},now);
  const prepared=j.get(id),proof=proveDraft(prepared,f.observation(prepared),now);
  assert.throws(()=>j.beginSubmit(id,proof,now),{code:'RESTORE_SKU_BUDGET'});assert.equal(j.get(id).submitAttempts,0);assert.equal(j.get(id).riskAttempts,0);
  j.transition(id,'prepared','submitting',{submitAttempts:1,submittedAt:now,draftProof:proof},now);j.recoverInterrupted(shopId,now);
  const pendingRisk=j.get(id),riskObservation={...f.observation(pendingRisk),dialogs:[`1个商品存在低价风险，请谨慎新建 预估最低到手价 ID：${b.productId} 仍要创建`]};
  assert.throws(()=>j.beginRiskConfirmation(id,{taskId:id,kind:'original-discount-risk',at:now,observation:riskObservation},now),{code:'RESTORE_SKU_BUDGET'});
  assert.equal(j.get(id).riskAttempts,0,'an oversized legacy unknown cannot complete a new risk confirmation');
  const committed=structuredClone(j.get(id)),observed={...f.observation(committed),kind:'activity',status:'进行中',campaignId:'4700000000000000099'};
  f.platform.readback=async()=>observed;const service=new GuardianService({journal:j,...f,now:()=>now});
  assert.equal(await service.reconcile(committed),true);assert.equal(j.get(id).phase,'verified');assert.equal(j.get(id).receipt.skuCount,501);assert.equal(f.counts.submits,0);
  assert.equal(fingerprint(j.get(id).plans),fingerprint(committed.plans));
 }finally{j.close();}
});
