import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {parseRemovalPriceRatio,checkRemovalPrices} from '../src/removal-export.mjs';
import {makeRemovalPriceReview} from '../src/ratio-prices.mjs';
import {makeDualActivityDecision} from '../src/dual-activity-recovery.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';
import {dualDecisionFixture,dualDraftObservation} from './helpers/dual-activity-fixture.mjs';

// The actual F1 removal contains all three statements, with no SKU group IDs.
const reasonFor=ratio=>`该商品各SKU售卖价，最高价需在最低价的${ratio}倍以内，请修改后再提交。平台规范合理设置SKU价格以保障消费者体验，规则详见：https://school.jinritemai.com/`;
const actualReason=['26','3.5','5.3'].map(reasonFor).join('\n');

for(const values of [['26','3.5','5.3'],['5.3','3.5'],['3.5','26','3.5']])
test('distinct ungrouped removal ratios never become a global minimum: '+values.join('/'),()=>{
 assert.throws(()=>parseRemovalPriceRatio(values.map(reasonFor).join('\n')),error=>{
  assert.equal(error.code,'REMOVAL_RULE_AMBIGUOUS');assert.match(error.message,/规格分组/);assert.match(error.message,/逐规格/);return true;
 });
});

test('repeated numerically equal removal ratios remain a single exact constraint',()=>{
 assert.deepEqual(parseRemovalPriceRatio(['3.5','3.50','3.500'].map(reasonFor).join('\n')),{numerator:35,denominator:10});
});

for(const mixed of [false,true])test('actual three-ratio export cannot invent a whole-product raise or reduction: '+mixed,()=>{
 const j=new Journal(':memory:');try{
  const f=ratioFixture(j,{mixed}),before=structuredClone(f.plan);
  f.loss.removal.reason=actualReason;f.loss.removalEvidence.record=structuredClone(f.loss.removal);
  assert.throws(()=>checkRemovalPrices(f.plan,f.loss.removal),{code:'REMOVAL_RULE_AMBIGUOUS'});
  assert.throws(()=>makeRemovalPriceReview(f.plan,f.loss,now),{code:'REMOVAL_RULE_AMBIGUOUS'});
  assert.throws(()=>j.recordRemovalPriceReview(f.plan,f.loss,now),{code:'REMOVAL_RULE_AMBIGUOUS'});
  assert.deepEqual(f.plan,before);assert.equal(j.priceReviews(f.policy.shopId).length,0);
  assert.equal(j.priceTarget(f.policy.shopId,f.plan.productId),null);assert.equal(j.list(f.policy.shopId).length,0);
 }finally{j.close();}
});

function ambiguousProbe(f,type,{explicitErrors=false}={}){
 const entry=structuredClone(f.probes.find(p=>p.type===type)),record={productId:f.plan.productId,name:f.plan.name,reason:actualReason};
 entry.task.lossEvidence={priceRules:[{complete:true,active:false,observedAt:now,lossKey:'fresh-ambiguous-export',removal:record,
  removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:f.plan.shopId,campaignId:f.baseline.campaignId,activityType:type,observedAt:now,sha256:'a'.repeat(64),record:structuredClone(record)}}]};
 entry.observation=dualDraftObservation(entry.task,{now,...(explicitErrors?{capFen:5900}:{})});return entry;
}

for(const explicitErrors of [false,true])test('a fresh draft does not silently erase the ambiguous source group restriction: '+explicitErrors,()=>{
 const j=new Journal(':memory:');try{
  const f=dualDecisionFixture(j,{now}),probes=['限时抢购','限量抢购'].map(type=>ambiguousProbe(f,type,{explicitErrors}));
  const decision=makeDualActivityDecision({plan:f.plan,probes,now});
  assert.deepEqual(decision.schemes.map(s=>s.classification),['pending','pending']);
  assert.ok(decision.schemes.every(s=>s.code==='REMOVAL_RULE_AMBIGUOUS'&&/逐规格/.test(s.reason)&&s.review===null&&!s.candidate));
  assert.equal(decision.selectedType,null);assert.equal(decision.approvalAllowed,false);
  assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId),null);assert.equal(j.list(f.plan.shopId).length,0);
 }finally{j.close();}
});

test('independent fresh SKU-specific limits still produce their exact two distinct price proposals',()=>{
 const j=new Journal(':memory:');try{
  const f=dualDecisionFixture(j,{now,caps:{'限时抢购':5900,'限量抢购':5700}}),decision=f.decision;
  assert.ok(decision.schemes.every(s=>s.classification==='reduction-required'));
  assert.equal(decision.approvalAllowed,true);assert.equal(decision.selectedType,null);
  assert.deepEqual(decision.schemes.map(s=>s.candidate.rows.find(r=>r.previousFen>r.saleFen).saleFen),[5900,5700]);
  assert.ok(decision.schemes.every(s=>s.candidate.rows.length===f.plan.skus.length));
  assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId),null);assert.equal(j.list(f.plan.shopId).length,0);
 }finally{j.close();}
});
