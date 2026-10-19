import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {planOriginalRestore,proveDraft,fingerprint} from '../src/policy.mjs';

const now=Date.now();
function data(){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',campaignId:'400001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60}]};
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const current={shopId:'900001',productId:'300001',observedAt:now,complete:true,skus:[{id:null,idSource:'unavailable-in-create-form',name:'规格甲',baseFen:10000}]};
 return {baseline,policy,current};
}
test('UI without SKU IDs records unique-name mapping instead of inventing observed IDs',()=>{
 const d=data(),p=planOriginalRestore(d.baseline,d.current,d.policy,now);
 assert.equal(p.skus[0].id,'500001');assert.equal(p.skus[0].mapping,'unique-name-and-base');
 assert.equal(p.skus[0].observedId,null);
});
test('a changed observed SKU ID may not fall back to its old name',()=>{
 const d=data();d.current.skus[0].id='500002';
 assert.throws(()=>planOriginalRestore(d.baseline,d.current,d.policy,now),{code:'NEW_OR_AMBIGUOUS_SKU'});
});
test('unsupported limited history cannot authorize an unrestricted draft',()=>{
 const d=data();d.current.skus=d.baseline.skus;d.baseline.rules.noLimit=false;
 assert.throws(()=>planOriginalRestore(d.baseline,d.current,d.policy,now),{code:'UNSUPPORTED_RULE'});
});
test('missing loss identity is rejected before enqueue',()=>{
 const d=data();d.current.skus=d.baseline.skus;const p=planOriginalRestore(d.baseline,d.current,d.policy,now),j=new Journal(':memory:');
 try{assert.throws(()=>j.enqueue('900001',[p],{complete:true,observedAt:now}),{code:'LOSS_UNPROVEN'});}finally{j.close();}
});
test('constructing a second service cannot mark another live writer unknown',()=>{
 const d=data();d.current.skus=d.baseline.skus;const j=new Journal(':memory:');
 try{const p=planOriginalRestore(d.baseline,d.current,d.policy,now),t=j.enqueue('900001',[p],{complete:true,observedAt:now,lossKey:'loss'});
 j.transition(t.id,'queued','prepared');j.transition(t.id,'prepared','submitting',{submitAttempts:1});j.lease('900001','first',now);
 new GuardianService({journal:j,platform:{},policy:d.policy});assert.equal(j.get(t.id).phase,'submitting');
 }finally{j.close();}
});
test('boolean samePrices alone is never a durable risk confirmation proof',()=>{
 const d=data();d.current.skus=d.baseline.skus;const j=new Journal(':memory:');
 try{const p=planOriginalRestore(d.baseline,d.current,d.policy,now),t=j.enqueue('900001',[p],{complete:true,observedAt:now,lossKey:'loss'});
 j.transition(t.id,'queued','prepared');j.transition(t.id,'prepared','submitting',{submitAttempts:1});
 assert.throws(()=>j.beginRiskConfirmation(t.id,{taskId:t.id,samePrices:true},now),{code:'RISK_PROOF'});
 }finally{j.close();}
});
