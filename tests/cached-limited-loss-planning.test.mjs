import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';

for(const mode of ['nested-product','wrong-nested','wrong-top','wrong-absence','conflicting-nested','missing-product'])
test('cached limited-loss metadata schedules only a correctly scoped fresh precheck: '+mode,async()=>{
 const now=Date.now(),journal=new Journal(':memory:');let service,prechecks=0;
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',name:'历史下架商品',
  campaignId:'400001',historyAt:now-100000,durationMs:604800000,type:'限量抢购',activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
  skus:[{id:'500001',name:'原规格',baseFen:10000,discount:50}]};
 const policy={shopId:baseline.shopId,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 const limitedLoss={branch:'auto-renew-or-duration-unproven',productId:baseline.productId,referenceCampaignId:baseline.campaignId};
 const detail={limitedLoss};
 if(mode==='wrong-nested')limitedLoss.productId='300002';
 if(mode==='wrong-top')detail.productId='300002';
 if(mode==='wrong-absence')limitedLoss.currentAbsence={productId:'300002'};
 if(mode==='conflicting-nested'){limitedLoss.productId='300002';limitedLoss.currentAbsence={productId:baseline.productId};}
 if(mode==='missing-product')delete limitedLoss.productId;
 const platform={discover:async()=>({activeComplete:true,baselines:[]}),
  loss:async()=>{throw Object.assign(new Error('Cached source needs a new bounded read'),{code:'LIMITED_LOSS_UNPROVEN',detail});},
  precheck:async()=>{prechecks++;throw Object.assign(new Error('Live exact product row confirms off shelf'),{code:'OFF_SHELF'});},
  precheckBatch:async()=>assert.fail('Single product requires the single-product current read'),
  lossBatch:async()=>assert.fail('Off-shelf products cannot proceed to an absence or submission proof'),
  prepare:async()=>assert.fail('No draft is permitted'),submit:async()=>assert.fail('No submission is permitted')};
 try{
  journal.remember(baseline,now);service=new GuardianService({journal,platform,policy});
  await service.tick();assert.equal(service.lastRun.ok,true);
  const expected=mode==='nested-product';assert.equal(prechecks,expected?1:0);
  assert.equal(journal.productChecks(policy.shopId)[0].code,expected?'OFF_SHELF':'LIMITED_LOSS_UNPROVEN');
  assert.equal(journal.list(policy.shopId).length,0);assert.equal(journal.priceReviews(policy.shopId).length,0);
 }finally{service?.stop();journal.close();}
});
