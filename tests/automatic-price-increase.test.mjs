import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {makePriceReviews,applyPriceTarget} from '../src/price-review.mjs';
import {proveDraft} from '../src/policy.mjs';
import {fixedNow as now,priceFixture} from './helpers/price-review-fixture.mjs';

async function policyApi(){return import('../src/price-increase-policy.mjs');}
function setup(j,{mixed=false}={}){
 const accounts=new AccountRegistry(j);accounts.register({shopId:'900001'},'signin-a');accounts.register({shopId:'900002'},'signin-b');accounts.select('900001');
 const f=priceFixture(j);f.probe.rows[0].errors=['活动价不得低于近15天最低价（70元）'];
 f.probe.rows[1].errors=mixed?['活动价不得高于58元']:[];f.probe.warnings=f.probe.rows.flatMap(s=>s.errors);
 const review=j.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);j.transition(f.task.id,'queued','blocked',{},now);return{...f,review};
}

test('automatic higher-price policy is off on fresh stores and requires its own shop-specific human consent',async()=>{
 const {setPriceIncreasePolicy,activePriceIncreaseGrant}=await policyApi(),j=new Journal(':memory:');try{
  setup(j);assert.equal(activePriceIncreaseGrant(j,'900001',now),null);
  assert.throws(()=>setPriceIncreasePolicy(j,'900001',{enabled:true},now),{code:'PRICE_INCREASE_CONSENT_REQUIRED'});
  setPriceIncreasePolicy(j,'900001',{enabled:true,acceptHigherPricesAndRisk:true},now);
  assert.ok(activePriceIncreaseGrant(j,'900001',now));assert.equal(activePriceIncreaseGrant(j,'900002',now),null);
  assert.throws(()=>setPriceIncreasePolicy(j,'900099',{enabled:true,acceptHigherPricesAndRisk:true},now),{code:'ACCOUNT_UNKNOWN'});
 }finally{j.close();}
});

test('an authorized higher target records policy approval rather than pretending to be exact human consent',async()=>{
 const {setPriceIncreasePolicy}=await policyApi(),j=new Journal(':memory:');try{
  const f=setup(j),r=f.review;setPriceIncreasePolicy(j,r.shopId,{enabled:true,acceptHigherPricesAndRisk:true},now);
  const approved=j.approvePriceIncrease(r.shopId,r.id,r.key,r.historicalFingerprint,now+1);
  assert.equal(approved.approvalKind,'automatic-price-increase');assert.equal(approved.consent,undefined);assert.ok(approved.automaticConsent.grantId);
  const plan=applyPriceTarget(f.plan,approved);j.assertPricePlans(r.shopId,[plan]);assert.equal(plan.skus[0].discount,51);assert.equal(plan.originalRiskAllowed,false);
  assert.equal(j.histories(r.shopId)[0].skus[0].discount,50);
 }finally{j.close();}
});

for(const mutation of ['no-policy','other-shop-policy','mixed','expired-proof','changed-key','changed-history','declined','unknown','not-nearest','fake-floor','fake-previous-price'])test('automatic policy refuses '+mutation,async()=>{
 const {setPriceIncreasePolicy}=await policyApi(),j=new Journal(':memory:');try{
  const f=setup(j,{mixed:mutation==='mixed'}),r=f.review;
  if(mutation!=='no-policy')setPriceIncreasePolicy(j,mutation==='other-shop-policy'?'900002':r.shopId,{enabled:true,acceptHigherPricesAndRisk:true},now);
  if(mutation==='declined')j.decidePriceReview(r.shopId,r.id,r.key,'decline',{},now+1);
  if(mutation==='unknown'){
   const task=j.enqueue(r.shopId,[f.plan],{complete:true,lossKey:'another-outstanding-task',observedAt:now},now+1);
   j.transition(task.id,'queued','prepared',{},now+1);
   j.beginSubmit(task.id,proveDraft(task,{...f.probe,title:task.title,warnings:[],rows:f.probe.rows.map(row=>({...row,errors:[]}))},now+1),now+1);
   j.transition(task.id,'submitting','unknown',{},now+1);
  }
  if(['not-nearest','fake-floor','fake-previous-price'].includes(mutation)){
   const body=j.priceReview(r.id);if(mutation==='not-nearest'){body.rows[0].discount=52;body.rows[0].saleFen=7228;}else if(mutation==='fake-floor')body.rows[0].evidence=['未知限制'];
   else{body.rows[0].previousDiscount=49;body.rows[0].previousFen=6811;}
   j.db.prepare('UPDATE price_reviews SET body=? WHERE id=?').run(JSON.stringify(body),r.id);
  }
  assert.throws(()=>j.approvePriceIncrease(r.shopId,r.id,mutation==='changed-key'?'changed':r.key,mutation==='changed-history'?'changed':r.historicalFingerprint,mutation==='expired-proof'?now+31000:now+2));
  assert.equal(j.priceTarget(r.shopId,r.productId),null);
 }finally{j.close();}
});

test('disabling automatic increases stops new targets while retaining earlier exact policy-approved targets',async()=>{
 const {setPriceIncreasePolicy,activePriceIncreaseGrant}=await policyApi(),j=new Journal(':memory:');try{
  const f=setup(j),r=f.review;setPriceIncreasePolicy(j,r.shopId,{enabled:true,acceptHigherPricesAndRisk:true},now);
  const target=j.approvePriceIncrease(r.shopId,r.id,r.key,r.historicalFingerprint,now+1),plan=applyPriceTarget(f.plan,target);
  setPriceIncreasePolicy(j,r.shopId,{enabled:false},now+2);assert.equal(activePriceIncreaseGrant(j,r.shopId,now+3),null);j.assertPricePlans(r.shopId,[plan]);
  const tampered=structuredClone(plan);tampered.skus[0].discount=52;tampered.skus[0].saleFen=7228;assert.throws(()=>j.assertPricePlans(r.shopId,[tampered]));
 }finally{j.close();}
});
