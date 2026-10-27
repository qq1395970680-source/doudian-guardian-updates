import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {ratioFixture} from './helpers/ratio-review-fixture.mjs';
import {recoveryRequests,updateRecoveryRequest} from '../src/recovery-requests.mjs';

for(const mode of ['active','missing','ambiguous','stale','wrong-member'])test('picker active hints need independent activity proof before concluding a recheck: '+mode,async()=>{
 const j=new Journal(':memory:');let s;try{
  const now=Date.now(),f=ratioFixture(j,{now}),platform={
   precheck:async()=>{throw Object.assign(new Error('商品已有有效活动'),{code:'ALREADY_ACTIVE'});},
   precheckBatch:async()=>{throw Error('One product only');},
   lossBatch:async baselines=>{assert.deepEqual(baselines.map(b=>b.productId),[f.baseline.productId]);return[{productId:mode==='wrong-member'?'300002':f.baseline.productId,loss:{complete:true,active:mode!=='missing',ambiguous:mode==='ambiguous',observedAt:mode==='stale'?now-180000:Date.now(),campaignId:'400009'}}];}
  };
  s=new GuardianService({journal:j,platform,policy:f.policy,immediate:true});s.canRunImmediate=()=>false;
  s.requestRecovery([f.baseline.productId]);await s.runImmediate({atBoundary:true});
  const result=j.priceRecheckProgress(f.policy.shopId),row=result.records[0];assert.equal(j.list(f.policy.shopId).length,0,'Read-only active verification must never submit');
  if(mode==='active'){
   assert.equal(recoveryRequests(j,f.policy.shopId).items.length,0);assert.equal(row.state,'checked');assert.equal(result.pending,0);assert.match(row.message,/已有有效活动/);assert.doesNotMatch(row.message,/恢复已/);
  }else{assert.equal(result.pending,1);assert.equal(row.state,'blocked');}
 }finally{s?.stop();j.close();}
});

test('a later successful patrol concludes a previously deferred request without asking the owner to retry',async()=>{
 const j=new Journal(':memory:');let s;try{
  const f=ratioFixture(j,{now:Date.now()}),platform={discover:async()=>({activeComplete:true,baselines:[]}),
   loss:async()=>({complete:true,active:true,observedAt:Date.now(),campaignId:'400009'})};
  s=new GuardianService({journal:j,platform,policy:f.policy,immediate:true});s.canRunImmediate=()=>false;
  s.requestRecovery([f.baseline.productId]);const request=recoveryRequests(j,f.policy.shopId).items[0];
  updateRecoveryRequest(j,f.policy.shopId,request,{state:'deferred',code:'ALREADY_ACTIVE',reason:'仅有选品提示'});
  await s.tick();assert.equal(j.priceRecheckProgress(f.policy.shopId).pending,0);assert.equal(j.priceRecheckProgress(f.policy.shopId).records[0].state,'checked');
  assert.equal(j.list(f.policy.shopId).length,0);assert.equal(s.lastRun.ok,true);
 }finally{s?.stop();j.close();}
});
