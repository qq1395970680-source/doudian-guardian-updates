import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {GuardError} from '../src/policy.mjs';
import {ratioFixture,ratioNow} from './helpers/ratio-review-fixture.mjs';
test('unproven limited loss waits for its recorded retry time but a new source or positive membership bypasses cooldown',async()=>{
 const j=new Journal(':memory:');let clock=ratioNow,reads=0,reference='400001',positive=false;
 try{
  const f=ratioFixture(j),platform={inventory:{listing:{campaigns:[]},details:new Map()},discover:async()=>({activeComplete:true,baselines:[]}),
   limitedReference:()=>({campaignId:reference}),loss:async()=>{
    reads++;if(positive)return{complete:true,active:true};
    throw new GuardError('LIMITED_LOSS_UNPROVEN','来源证据不足',{limitedLoss:{referenceCampaignId:reference,branch:'member-unproven'}});
   }};
  const s=new GuardianService({journal:j,platform,policy:f.policy,now:()=>clock});
  await s.tick();const first=j.productChecks(f.policy.shopId)[0];assert.equal(reads,1);assert.equal(first.limitedLoss.branch,'member-unproven');
  clock+=1000;await s.tick();assert.equal(reads,1);assert.equal(j.productChecks(f.policy.shopId)[0].at,first.at);
  reference='400002';await s.tick();assert.equal(reads,2);
  positive=true;platform.inventory={listing:{campaigns:[{id:reference,status:'进行中'}]},details:new Map([[reference,{products:[{productId:f.baseline.productId}]}]])};
  await s.tick();assert.equal(reads,3);assert.equal(j.productChecks(f.policy.shopId).length,0);
 }finally{j.close();}
});
