import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {proveDraft,planOriginalRestore} from '../src/policy.mjs';

function pending(){
 const now=Date.now(),journal=new Journal(':memory:');
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',campaignId:'400001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60}]};
 const policy={shopId:'900001',originalRiskAllowed:true,allowMissingHistoricalSkus:true};
 const plan=planOriginalRestore(baseline,{shopId:'900001',productId:'300001',complete:true,observedAt:now,skus:baseline.skus},policy,now);
 const task=journal.enqueue(policy.shopId,[plan],{complete:true,observedAt:now,lossKey:'absent'},now);
 const observation={kind:'draft',shopId:policy.shopId,title:task.title,type:plan.type,rules:plan.rules,complete:true,observedAt:now,startAt:now,endAt:now+48*3600000,rows:plan.skus.map(s=>({...s,productId:plan.productId})),warnings:[],dialogs:[]};
 journal.transition(task.id,'queued','prepared',{},now);journal.beginSubmit(task.id,proveDraft(task,observation,now),now);journal.transition(task.id,'submitting','unknown',{reason:'native risk dialog still open'},now);
 const later=now+10*60000,proof={taskId:task.id,kind:'original-discount-risk',at:later,observation:{...observation,observedAt:later,dialogs:['1个商品存在低价风险，请谨慎新建 预估最低到手价 ID：300001 仍要创建']}};
 return {journal,task,now,later,proof};
}
test('retained native risk can confirm its exact recorded original time after a delay',()=>{
 const {journal,task,later,proof}=pending();try{journal.beginRiskConfirmation(task.id,proof,later);assert.equal(journal.get(task.id).riskAttempts,1);assert.equal(journal.get(task.id).submitAttempts,1);
 assert.throws(()=>journal.beginRiskConfirmation(task.id,proof,later),{code:'RISK_PROOF'});
 }finally{journal.close();}
});
for(const change of ['price','time','identity','warning','expired'])test('retained risk rejects '+change,()=>{
 const {journal,task,later,proof}=pending();try{
  if(change==='price')proof.observation.rows[0].saleFen--;
  if(change==='time'){proof.observation.startAt+=1000;proof.observation.endAt+=1000;}
  if(change==='identity')proof.observation.dialogs[0]=proof.observation.dialogs[0].replace('300001','300002');
  if(change==='warning')proof.observation.warnings=['价格不符合要求'];
  const at=change==='expired'?proof.observation.endAt+1000:later;if(change==='expired'){proof.at=at;proof.observation.observedAt=at;}
  assert.throws(()=>journal.beginRiskConfirmation(task.id,proof,at));assert.equal(journal.get(task.id).riskAttempts,0);
 }finally{journal.close();}
});
