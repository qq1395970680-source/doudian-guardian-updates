import test from 'node:test';
import assert from 'node:assert/strict';
import {priceRemovalAfterActiveHint} from '../src/active-hint-removal.mjs';
import {fingerprint} from '../src/policy.mjs';
const now=1793115000000;
const baseline={shopId:'900001',productId:'3800000000000000101'};
function proof(){
 const record={productId:baseline.productId,name:'已被剔除的独立商品',reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'};
 return{productId:baseline.productId,loss:{complete:true,active:false,observedAt:now,lossKey:fingerprint(record),removal:record,
  removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:baseline.shopId,campaignId:'4800000000000000101',
   activityType:'限量抢购',observedAt:now,sha256:'a'.repeat(64),record:structuredClone(record)}}};
}
test('an independent exact removal classifies the source restriction without supplying an execution plan or approving prices',()=>{
 const input=proof(),original=structuredClone(input),error=priceRemovalAfterActiveHint(input,baseline,now);
 assert.equal(error.code,'SKU_RATIO_REVIEW_REQUIRED');assert.match(error.message,/3\.5/);
 assert.equal(error.detail.activeHintRemoval.pricePlanReady,false);
 assert.equal(error.detail.activeHintRemoval.origin,'independent-removal-after-picker-hint');
 assert.equal(error.detail.activeHintRemoval.activityType,'限量抢购');
 assert.deepEqual(input,original);assert.equal(error.plan,undefined);assert.equal(error.rows,undefined);
});
const mutations={
 'wrong shop':p=>p.loss.removalEvidence.shopId='900002',
 'wrong returned target':p=>p.productId='3800000000000000102',
 'wrong removal product':p=>p.loss.removal.productId='3800000000000000102',
 'conflicting record':p=>p.loss.removalEvidence.record.reason='该商品各SKU售卖价，最高价需在最低价的5倍以内，请修改后再提交。',
 'future export':p=>p.loss.removalEvidence.observedAt=now+5001,
 'expired export':p=>p.loss.removalEvidence.observedAt=now-120001,
 'expired loss':p=>p.loss.observedAt=now-120001,
 'incomplete export':p=>p.loss.removalEvidence.complete=false,
 'incomplete loss':p=>p.loss.complete=false,
 'positive membership':p=>p.loss.active=true,
 'ambiguous loss':p=>p.loss.ambiguous=true,
 'unverifiable export digest':p=>p.loss.removalEvidence.sha256='missing',
 'unsupported source':p=>p.loss.removalEvidence.source='diagnostic-import',
 'unknown restriction':p=>{p.loss.removal.reason='请联系客服';p.loss.removalEvidence.record.reason='请联系客服';},
 'unknown source activity type':p=>p.loss.removalEvidence.activityType='未知活动',
 'sold-out source':p=>p.loss.continuity={soldOut:true},
 'cancelled source':p=>p.loss.continuity={status:'已作废'},
 'failed independent read':p=>p.error={code:'READ_ERROR'},
 'invalid source activity id':p=>p.loss.removalEvidence.campaignId='not-an-activity'
};
for(const [label,mutate] of Object.entries(mutations))test('unproven removal keeps its unresolved protection: '+label,()=>{
 const input=proof();mutate(input);assert.equal(priceRemovalAfterActiveHint(input,baseline,now),null);
});
