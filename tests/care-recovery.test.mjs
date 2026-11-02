import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {activeCareRecoveryGrant,setCareRecoveryPolicy,validCarePriceApproval} from '../src/care-recovery-policy.mjs';
import {validAutomaticPriceApproval} from '../src/price-increase-policy.mjs';
import {fingerprint,planOriginalRestore} from '../src/policy.mjs';
import {careServiceFixture} from './helpers/care-service-fixture.mjs';
import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';
import {makeTransfer,importTransfer} from '../src/migration.mjs';
import {activeOriginalPriceRecoveryGrant} from '../src/original-price-recovery-policy.mjs';
import {workspaceOwnership} from '../src/workspace-ownership.mjs';

for(const scenario of ['floor','ratio','mixed','unknown'])test('care recovery follows only exact non-reducing current-type evidence: '+scenario,async()=>{
 const journal=new Journal(':memory:');try{
  const f=careServiceFixture(journal,{ratio:scenario==='ratio',mixed:scenario==='mixed',dropReadback:scenario==='unknown'});let service=new GuardianService({journal,...f});
  await service.tick();const target=journal.priceTarget(f.policy.shopId,f.baseline.productId);
  if(scenario==='mixed'){assert.equal(f.state.submits,0);assert.equal(target,null);assert.ok(journal.priceReviews(f.policy.shopId).some(r=>r.status==='pending'&&r.rows.some(row=>row.saleFen<row.previousFen)));return;}
  assert.ok(target,JSON.stringify(journal.events(15)));assert.equal(target.approvalKind,'automatic-price-increase');assert.ok(target.automaticConsent.careGrantId);assert.equal(target.consent,undefined);assert.ok(target.rows.every(row=>row.saleFen>=row.previousFen));assert.equal(target.type,f.baseline.type);
  assert.ok(validAutomaticPriceApproval(journal,target));assert.ok(validCarePriceApproval(journal,target));assert.equal(f.state.submits,1,JSON.stringify(journal.events(20)));
  if(scenario==='unknown'){const unknown=journal.list(f.policy.shopId).find(t=>t.phase==='unknown');assert.ok(unknown);const attempts=unknown.submitAttempts;service=new GuardianService({journal,...f});await service.tick();assert.equal(journal.get(unknown.id).phase,'verified');assert.equal(journal.get(unknown.id).submitAttempts,attempts);assert.equal(f.state.submits,1);}
  else assert.equal(service.status().verified,1);
  await service.tick();assert.equal(f.state.submits,1,'same loss cannot create another task');
  assert.equal(journal.histories(f.policy.shopId)[0].skus[0].discount,f.baseline.skus[0].discount);
 }finally{journal.close();}
});

test('care mode needs new explicit shop consent, preserves original grants and exposes one scoped policy',async()=>{
 const x=await blockerFixture();try{
  assert.equal(activeCareRecoveryGrant(x.journal,x.review.shopId),null);
  const refused=await x.post('care-recovery-policy',{shopId:x.review.shopId,enabled:true});assert.equal(refused.status,400);
  const accepted=await x.post('care-recovery-policy',{shopId:x.review.shopId,enabled:true,acceptNonReducingRecovery:true});assert.equal(accepted.status,200,await accepted.clone().text());
  assert.equal(x.app.snapshot().careRecoveryEnabled,true);assert.equal(x.app.snapshot().automaticPriceIncreaseEnabled,true);assert.equal(x.journal.settings('original-price-recovery-policy:'+x.review.shopId).grantId,x.grant.id);
  assert.equal(activeCareRecoveryGrant(x.journal,'900002'),null);
  await x.post('care-recovery-policy',{shopId:x.review.shopId,enabled:false});assert.equal(x.app.snapshot().careRecoveryEnabled,false);assert.equal(activeOriginalPriceRecoveryGrant(x.journal,x.review.shopId).id,x.grant.id);
 }finally{await x.close();}
});

test('care target archives exact evidence and stays valid after stopping future automatic adjustments',async()=>{
 const journal=new Journal(':memory:');try{const f=careServiceFixture(journal),service=new GuardianService({journal,...f});await service.tick();const target=journal.priceTarget(f.policy.shopId,f.baseline.productId);setCareRecoveryPolicy(journal,f.policy.shopId,{enabled:false},f.now());assert.ok(validCarePriceApproval(journal,target));const altered=structuredClone(target);altered.rows[0].saleFen--;assert.equal(validCarePriceApproval(journal,altered),false);const alteredSource=structuredClone(target);alteredSource.careSource.rows[0].bounds.minFen++;assert.equal(validCarePriceApproval(journal,alteredSource),false);}finally{journal.close();}
});

test('a later offer below an automatically raised guard target needs manual approval even above the original historical price',async()=>{
 const journal=new Journal(':memory:');try{
  const f=careServiceFixture(journal),service=new GuardianService({journal,...f});f.state.floorFen=6300;await service.tick();
  const target=journal.priceTarget(f.policy.shopId,f.baseline.productId),oldFen=6000;assert.equal(target.rows[0].saleFen,6300);assert.equal(f.state.submits,1);
  f.state.active=false;f.state.floorFen=0;f.state.capFen=6250;f.state.lossRevision++;f.advance(1000);await service.tick();
  const review=journal.priceReviews(f.policy.shopId).find(r=>r.status==='pending');assert.ok(review,JSON.stringify(journal.events(15)));const changed=review.rows[0];assert.equal(changed.previousFen,6300);assert.equal(changed.saleFen,6200);assert.ok(changed.saleFen>oldFen);
  assert.equal(f.state.submits,1,'a price lower than the newly guarded price must never be submitted automatically');assert.equal(journal.priceTarget(f.policy.shopId,f.baseline.productId).id,target.id);
  const ownership=workspaceOwnership({shopId:f.policy.shopId,reviews:journal.priceReviews(f.policy.shopId),tasks:journal.list(f.policy.shopId),careEnabled:true,now:f.now()});assert.equal(ownership.byProduct.get(f.baseline.productId).owner,'prices');
 }finally{journal.close();}
});

test('migration transfers unknown facts without care consent or target authority',async()=>{
 const source=new Journal(':memory:'),target=new Journal(':memory:');try{
  const f=careServiceFixture(source,{dropReadback:true}),service=new GuardianService({journal:source,...f});await service.tick();const grant=activeCareRecoveryGrant(source,f.policy.shopId),unknown=source.list(f.policy.shopId).find(t=>t.phase==='unknown');assert.ok(unknown);
  const file=makeTransfer(source,{shopId:f.policy.shopId,name:'care migration fixture'},{version:'beta.59',now:f.now()});assert.equal(JSON.stringify(file).includes(grant.id),false);
  const imported=importTransfer(target,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},f.now());assert.equal(imported.unknown,1);assert.equal(activeCareRecoveryGrant(target,f.policy.shopId),null);assert.equal(target.priceTarget(f.policy.shopId,f.baseline.productId),null);assert.equal(activeOriginalPriceRecoveryGrant(target,f.policy.shopId),null);
  const locked=target.get(unknown.id);assert.equal(locked.phase,'unknown');assert.equal(locked.submitAttempts,1);assert.equal(locked.riskAttempts,1);assert.equal(locked.plans[0].approvedRiskAllowed,false);assert.equal(locked.plans[0].priceApprovalId,undefined);assert.equal(source.get(unknown.id).submitAttempts,1);
 }finally{source.close();target.close();}
});

test('transient read failure automatically retries after a bounded delay without a manual reset',async()=>{
 const journal=new Journal(':memory:');try{const f=careServiceFixture(journal),original=f.platform.precheck;let failed=false;f.platform.precheck=async b=>{if(!failed){failed=true;throw Object.assign(new Error('temporary timeout'),{code:'READ_OPERATION_TIMEOUT'});}return original(b);};const service=new GuardianService({journal,...f});await service.tick();assert.equal(f.state.submits,0);const check=journal.productChecks(f.policy.shopId)[0];assert.equal(check.retryAt-f.now(),60000);f.advance(59999);await service.tick();assert.equal(f.state.submits,0);f.advance(1);await service.tick();assert.equal(f.state.submits,1);}finally{journal.close();}
});

test('old zero-submit cooldown can be explicitly refreshed, committed boundaries can never use that path',()=>{
 const journal=new Journal(':memory:');try{const f=careServiceFixture(journal),plan=planOriginalRestore(f.baseline,{...f.baseline,observedAt:f.now()},f.policy,f.now()),task=journal.enqueue(f.policy.shopId,[plan],{complete:true,observedAt:f.now(),lossKey:'retry'},f.now());journal.transition(task.id,'queued','blocked',{reason:'READ_OPERATION_TIMEOUT',retryAfter:f.now()+900000},f.now());f.advance(1);assert.equal(journal.requestFreshUnsubmittedRecheck(task.id,f.now(),f.now()),true);assert.equal(journal.get(task.id).retryAfter,f.now());const t=journal.get(task.id);journal.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...t,submitAttempts:1,riskAttempts:0}),task.id);f.advance(1);assert.equal(journal.requestFreshUnsubmittedRecheck(task.id,f.now(),f.now()),false);}finally{journal.close();}
});

test('care can carry a pure upward rounding correction without changing the discount or activity',()=>{
 const journal=new Journal(':memory:');try{
  const f=careServiceFixture(journal),now=f.now(),baseline={...f.baseline,skus:[{id:'5500000000000000999',name:'取整规格',baseFen:6875,discount:95}]},current={...baseline,observedAt:now};journal.remember(baseline,now);
  const previous={id:'old-rounding',key:'old-rounding-key',status:'approved',shopId:f.policy.shopId,productId:baseline.productId,name:baseline.name,historicalFingerprint:fingerprint(baseline),type:baseline.type,rules:baseline.rules,consent:{exactPrices:true,matchedRiskConfirmation:true},createdAt:now-1000,approvedAt:now-900,expiresAt:now-1,rows:[{id:baseline.skus[0].id,name:'取整规格',baseFen:6875,historicalDiscount:95,previousDiscount:95,previousFen:6531,discount:95,saleFen:6531,bounds:{},evidence:[]}]};journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(previous.id,previous.shopId,previous.productId,previous.status,JSON.stringify(previous),now);journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(previous.shopId,previous.productId,previous.id);
  const service=new GuardianService({journal,...f}),plan=service.restorePlan(baseline,current);assert.equal(plan.skus[0].saleFen,6532);assert.equal(plan.skus[0].discount,95);assert.equal(plan.type,baseline.type);journal.assertPricePlans(f.policy.shopId,[plan]);assert.deepEqual(journal.priceReview(previous.id),previous);
 }finally{journal.close();}
});
