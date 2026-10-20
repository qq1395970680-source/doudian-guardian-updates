import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {makeTransfer,importTransfer} from '../src/migration.mjs';
import {priceFixture,fixedNow} from './helpers/price-review-fixture.mjs';
import {saleFen} from '../src/policy.mjs';
test('converted limited unknown task and higher price remain readback-only across transfer',()=>{
 const s=new Journal(':memory:'),d=new Journal(':memory:');try{
  const f=priceFixture(s),plan={...f.plan,type:'限量抢购',rules:{...f.plan.rules,noLimit:false,autoRenew:true},activityLimit:1000,durationMs:7*86400000,campaignPolicyFingerprint:'a'.repeat(64)};
  plan.skus=structuredClone(plan.skus);plan.skus[0].discount++;plan.skus[0].saleFen=saleFen(plan.skus[0].baseFen,plan.skus[0].discount);
  s.transition(f.task.id,'queued','prepared',{plans:[plan],title:'守护2-多折扣-123456789abc'},fixedNow+1);
  s.transition(f.task.id,'prepared','submitting',{submitAttempts:1},fixedNow+2);
  s.transition(f.task.id,'submitting','unknown',{},fixedNow+3);
  const file=makeTransfer(s,f.policy,{version:'2.0.0-beta.16',now:fixedNow+4});
  importTransfer(d,file,{shopId:f.policy.shopId,accepted:true,expectedDigest:file.digest},fixedNow+5);
  const task=d.get(f.task.id);
  assert.equal(task.phase,'unknown');assert.equal(task.riskAttempts,1);assert.equal(task.plans[0].originalRiskAllowed,false);
  assert.equal(task.plans[0].activityLimit,1000);assert.equal(task.plans[0].skus[0].discount,51);
  assert.equal(d.settings('campaign-policy:'+f.policy.shopId),null);
  assert.equal(d.priceTarget(f.policy.shopId,plan.productId),null);
 }finally{s.close();d.close();}
});
