import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {makePriceReviews} from '../src/price-review.mjs';
import {setCareRecoveryPolicy,validCarePriceApproval} from '../src/care-recovery-policy.mjs';
import {priceFixture} from './helpers/price-review-fixture.mjs';

function setup({mixed=false,enabled=true}={}){
 const j=new Journal(':memory:'),now=Date.now(),accounts=new AccountRegistry(j);accounts.register({shopId:'900001'},'signin-care-boundaries');accounts.authorizeOriginal('900001');
 const f=priceFixture(j,now);f.probe.rows[0].errors=['活动价不得低于近15天最低价（70元）'];f.probe.rows[1].errors=mixed?['活动价不得高于58元']:[];f.probe.warnings=f.probe.rows.flatMap(r=>r.errors);
 const review=j.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);j.transition(f.task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED: 平台价格限制',retryAfter:now+900000},now);
 if(enabled)setCareRecoveryPolicy(j,'900001',{enabled:true,acceptNonReducingRecovery:true},now);
 return{j,f,review,now};
}

for(const mutation of ['no-consent','disabled','expired','unknown','missing-sku','base','previous-price','unrecognized-rule','wrong-type','mixed','risk-boundary','key','history'])test('care exact-price policy refuses '+mutation,()=>{
 const x=setup({mixed:mutation==='mixed',enabled:mutation!=='no-consent'}),{j,f,review:r,now}=x;try{
  const body=structuredClone(r);
  if(mutation==='disabled')setCareRecoveryPolicy(j,r.shopId,{enabled:false},now+1);
  if(mutation==='expired')body.createdAt=now-31000;
  if(mutation==='unknown')j.enqueue(r.shopId,[f.plan],{complete:true,observedAt:now,lossKey:'unknown-care'},now);
  if(mutation==='missing-sku')body.rows.pop();if(mutation==='base')body.rows[0].baseFen++;if(mutation==='previous-price')body.rows[0].previousFen--;
  if(mutation==='unrecognized-rule')body.rows[0].evidence=['请改成平台认为合理的价格'];if(mutation==='wrong-type')body.type='限量抢购';
  if(mutation==='risk-boundary'){const task=j.get(f.task.id);j.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...task,riskAttempts:1}),task.id);}
  j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(body),r.id);
  assert.throws(()=>j.approveCarePriceReview(r.shopId,r.id,mutation==='key'?'changed':r.key,mutation==='history'?'changed':r.historicalFingerprint,now+2));assert.equal(j.priceTarget(r.shopId,r.productId),null);
 }finally{j.close();}
});

test('care approval seals activity rules, exact source evidence and all prices, including after disabling future changes',()=>{
 const x=setup(),{j,review:r,now}=x;try{const approved=j.approveCarePriceReview(r.shopId,r.id,r.key,r.historicalFingerprint,now+1);assert.ok(validCarePriceApproval(j,approved));for(const field of ['type','rules','evidence']){const altered=structuredClone(approved);if(field==='type')altered.type='限量抢购';if(field==='rules')altered.rules.orderMinutes=60;if(field==='evidence')altered.careEvidence.task.riskAttempts=1;assert.equal(validCarePriceApproval(j,altered),false,field);}setCareRecoveryPolicy(j,r.shopId,{enabled:false},now+2);assert.ok(validCarePriceApproval(j,approved));}finally{j.close();}
});

for(const beforePolicy of [true,false])test('fresh evidence can reconsider only a non-reducing decline made before the new care consent: '+beforePolicy,()=>{
 const x=setup({enabled:false}),{j,f,review:r,now}=x;try{
  if(!beforePolicy)setCareRecoveryPolicy(j,r.shopId,{enabled:true,acceptNonReducingRecovery:true},now);
  j.decidePriceReview(r.shopId,r.id,r.key,'decline',{},now+1);
  if(beforePolicy)setCareRecoveryPolicy(j,r.shopId,{enabled:true,acceptNonReducingRecovery:true},now+2);
  j.requestFreshUnsubmittedRecheck(f.task.id,now+3,now+3);const task=j.transition(f.task.id,'blocked','queued',{},now+3),probe={...f.probe,observedAt:now+3};
  const fresh=j.recordPriceReview(makePriceReviews(task,probe,now+3)[0],now+3);assert.equal(fresh.status,beforePolicy?'pending':'declined');assert.equal(j.priceReview(r.id).status,'declined');if(beforePolicy)assert.notEqual(fresh.id,r.id);
 }finally{j.close();}
});
