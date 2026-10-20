import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {makeTransfer,validateTransfer,importTransfer} from '../src/migration.mjs';
import {priceFixture,fixedNow} from './helpers/price-review-fixture.mjs';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {setPriceIncreasePolicy,activePriceIncreaseGrant} from '../src/price-increase-policy.mjs';

test('migration preserves full history and exclusions but never credentials or price permission',()=>{
 const source=new Journal(':memory:'),target=new Journal(':memory:');try{
  const f=priceFixture(source),account={...f.policy,name:'店铺甲',profileKey:'shop-900001',authorizationSource:'private',excludedProductIds:['3000000000000000999']};
  new AccountRegistry(source).register({shopId:f.policy.shopId},'signin-a');
  setPriceIncreasePolicy(source,f.policy.shopId,{enabled:true,acceptHigherPricesAndRisk:true},fixedNow);
  source.putSettings('secret',{token:'must-not-export'});
  const file=makeTransfer(source,account,{version:'2.0.0-beta.6',now:fixedNow+1});
  assert.doesNotMatch(JSON.stringify(file),/must-not-export|profileKey|authorizationSource|allowFurtherPriceReduction|originalRiskAllowed|approvedRiskAllowed|priceApprovalId|automaticConsent|price-increase|grantId/);
  const preview=validateTransfer(file,f.policy.shopId,fixedNow+2);assert.equal(preview.products.length,1);assert.equal(preview.products[0].skus.length,2);
  assert.throws(()=>importTransfer(target,file,{shopId:f.policy.shopId,accepted:false,expectedDigest:file.digest},fixedNow+2));
  const result=importTransfer(target,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+2);
  assert.equal(result.importedHistories,1);assert.deepEqual(result.excludedProductIds,account.excludedProductIds);
  assert.deepEqual(target.histories(f.policy.shopId),source.histories(f.policy.shopId));assert.equal(target.priceTarget(f.policy.shopId,f.plan.productId),null);
  assert.equal(target.settings(f.policy.shopId),null);assert.equal(target.settings('application'),null);
  assert.ok(activePriceIncreaseGrant(source,f.policy.shopId,fixedNow+2));assert.equal(activePriceIncreaseGrant(target,f.policy.shopId,fixedNow+2),null);
  assert.equal(importTransfer(target,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+3).alreadyImported,true);
 }finally{source.close();target.close();}
});

test('task conflict rolls back all histories and exclusions, and a later backup does not duplicate history',()=>{
 const s=new Journal(':memory:'),t=new Journal(':memory:');try{const f=priceFixture(s),file=makeTransfer(s,f.policy,{version:'2.0.0-beta.6',now:fixedNow+1});
  const other=structuredClone(f.task);other.title='守护2-123456789012345678';
  const {id,shopId,phase,updatedAt,...body}=other;t.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,shopId,'test-conflict','blocked',JSON.stringify(body),updatedAt);
  assert.throws(()=>importTransfer(t,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+2),{code:'TRANSFER_TASK'});
  assert.equal(t.histories(f.policy.shopId).length,0);assert.equal(t.db.prepare('SELECT count(*) AS n FROM migration_imports').get().n,0);
  t.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  importTransfer(t,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+2);
  const next=makeTransfer(s,f.policy,{version:'2.0.0-beta.6',now:fixedNow+3});
  assert.equal(importTransfer(t,next,{shopId:f.policy.shopId,accepted:true,expectedDigest:next.digest},fixedNow+4).importedHistories,0);
 }finally{s.close();t.close();}
});

for(const mode of ['diagnostic','tampered','wrong-shop','future','unknown-fields','duplicate-history','duplicate-task','forged-task-price','active-destination'])test('migration rejects unsafe input: '+mode,()=>{
 const s=new Journal(':memory:'),t=new Journal(':memory:');try{
  const f=priceFixture(s),file=makeTransfer(s,f.policy,{version:'2.0.0-beta.6',now:fixedNow+1});let shop=f.policy.shopId;
  if(mode==='diagnostic')file.format='doudian-discount-guardian-diagnostic';
  if(mode==='tampered')file.payload.histories[0].body.skus[0].discount=10;
  if(mode==='wrong-shop')shop='900002';
  if(mode==='future')file.payload.createdAt=fixedNow+60000;
  if(mode==='unknown-fields')file.payload.command='restore';
  if(mode==='duplicate-history')file.payload.histories.push(file.payload.histories[0]);
  if(mode==='duplicate-task')file.payload.tasks.push(file.payload.tasks[0]);
  if(mode==='forged-task-price')file.payload.tasks[0].plans[0].skus[0].baseFen++;
  if(!['tampered','diagnostic'].includes(mode))file.digest=fingerprint(file.payload);
  if(mode==='active-destination')priceFixture(t);
  assert.throws(()=>importTransfer(t,file,{shopId:shop,accepted:true,expectedDigest:file.digest},fixedNow+2));
  if(mode!=='active-destination')assert.equal(t.histories(f.policy.shopId).length,0);
 }finally{s.close();t.close();}
});

test('an uncertain submitted task transfers as readback-only and cannot be retried or risk-confirmed',()=>{
 const s=new Journal(':memory:'),t=new Journal(':memory:');try{const f=priceFixture(s);
  s.transition(f.task.id,'queued','prepared',{},fixedNow);
  s.beginSubmit(f.task.id,proveDraft(f.task,{...f.probe,warnings:[],rows:f.probe.rows.map(r=>({...r,errors:[]}))},fixedNow),fixedNow);
  const file=makeTransfer(s,f.policy,{version:'2.0.0-beta.6',now:fixedNow+1});
  const result=importTransfer(t,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+2);
  assert.equal(result.unknown,1);const task=t.get(f.task.id);assert.equal(task.phase,'unknown');assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);
  assert.equal(task.plans[0].originalRiskAllowed,false);assert.equal(task.draftProof,undefined);
  assert.throws(()=>t.transition(task.id,'unknown','queued',{},fixedNow+3));
  assert.throws(()=>t.enqueue(f.policy.shopId,[f.plan],{complete:true,lossKey:'fresh',observedAt:fixedNow},fixedNow+3));
 }finally{s.close();t.close();}
});
