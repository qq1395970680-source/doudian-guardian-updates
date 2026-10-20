import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {CampaignConversion} from '../src/campaign-conversion.mjs';
const target={type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}};
function example(){
 const journal=new Journal(':memory:'),now=Date.now(),campaign={id:'400001',name:'当前6折',type:'限时抢购',status:'进行中',startAt:now-100000,endAt:now+100000};
 const detail={complete:true,observedAt:now,rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},products:[
  {productId:'300001',name:'商品',skus:[{id:'500001',name:'规格',baseFen:10000,discount:60,saleFen:6000}]}]};
 let cancels=0,fail=false;
 const platform={async listActive(){return{complete:true,campaigns:campaign.status==='进行中'?[campaign]:[],observedAt:Date.now()};},
  async list(){return{complete:true,campaigns:[structuredClone(campaign)],observedAt:Date.now()};},async detail(){return structuredClone(detail);},
  async cancelCampaign(c,before){cancels++;await before('intent');if(fail==='before-confirm')throw Error('unconfirmed dialog');await before('confirm');if(fail)throw Error('connection lost');campaign.status='已作废';},
  async probe(){return{shopId:'900001'};}};
 const policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const service=new GuardianService({journal,platform,policy}),conversion=new CampaignConversion(service);
 return{journal,conversion,campaign,detail,platform,get cancels(){return cancels;},set fail(v){fail=v;}};
}
test('conversion preserves live baseline before cancellation and rechecks prices',async()=>{
 const x=example();try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  assert.equal(x.cancels,0);assert.equal(x.journal.histories('900001')[0].skus[0].discount,60);
  x.detail.products[0].skus[0].discount=55;
  await assert.rejects(()=>x.conversion.cancel('400001'),{code:'CONVERSION_CHANGED'});
  assert.equal(x.cancels,0);x.detail.products[0].skus[0].discount=60;
  await x.conversion.cancel('400001');assert.equal(x.cancels,1);
  await x.conversion.cancel('400001');assert.equal(x.cancels,1,'confirmed cancellation is idempotent');
 }finally{x.journal.close();}
});
test('unknown cancellation is never repeated after restart',async()=>{
 const x=example();try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  x.fail=true;await assert.rejects(()=>x.conversion.cancel('400001'));
  const restarted=new CampaignConversion(x.conversion.service);
  await assert.rejects(()=>restarted.cancel('400001'),{code:'CONVERSION_UNKNOWN'});
  assert.equal(x.cancels,1);
  x.campaign.status='已作废';await restarted.cancel('400001');
  assert.equal(restarted.state().campaigns[0].phase,'cancelled');assert.equal(x.cancels,1);
 }finally{x.journal.close();}
});
test('an unconfirmed dialog can reopen only after fresh unchanged-activity checks',async()=>{
 const x=example();try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  x.fail='before-confirm';await assert.rejects(()=>x.conversion.cancel('400001'));
  assert.equal(x.conversion.state().campaigns[0].confirmAttempts,0);
  x.detail.products[0].skus[0].discount=55;
  await assert.rejects(()=>x.conversion.cancel('400001'),{code:'CONVERSION_CHANGED'});assert.equal(x.cancels,1);
  x.detail.products[0].skus[0].discount=60;x.fail=false;
  await x.conversion.cancel('400001');assert.equal(x.cancels,2);assert.equal(x.conversion.state().campaigns[0].confirmAttempts,1);
 }finally{x.journal.close();}
});

const retryConsent={confirmed:true,source:'human-request',requestId:'one-explicit-retry',
 shopId:'900001',campaignId:'400001',productIds:['300001']};
test('an explicit scoped cancellation retry survives restart without resetting attempts',async()=>{
 const x=example();try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  x.fail=true;await assert.rejects(()=>x.conversion.cancel('400001'));
  x.conversion.authorizeCancellationRetry('400001',retryConsent);
  assert.equal(x.conversion.state().campaigns[0].confirmAttempts,1);
  const restarted=new CampaignConversion(x.conversion.service);
  x.detail.products[0].skus[0].discount=55;
  await assert.rejects(()=>restarted.cancel('400001'),{code:'CONVERSION_CHANGED'});
  assert.equal(x.cancels,1);
  x.detail.products[0].skus[0].discount=60;
  await assert.rejects(()=>restarted.cancel('400001'));
  assert.equal(x.cancels,2);assert.equal(restarted.state().campaigns[0].confirmAttempts,2);
  await assert.rejects(()=>restarted.cancel('400001'),{code:'CONVERSION_UNKNOWN'});
  assert.throws(()=>restarted.authorizeCancellationRetry('400001',{...retryConsent,requestId:'another'}),{code:'CONVERSION_CONSENT'});
  assert.equal(x.cancels,2);
  x.campaign.status='已作废';await restarted.cancel('400001');
  assert.equal(restarted.state().campaigns[0].phase,'cancelled');
 }finally{x.journal.close();}
});
test('cancellation retry rejects missing, automated or mismatched consent',async()=>{
 const x=example();try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  x.fail=true;await assert.rejects(()=>x.conversion.cancel('400001'));
  for(const patch of [{confirmed:false},{source:'diagnostic'},{shopId:'900002'},{campaignId:'400002'},{productIds:['300002']},{requestId:''}]){
   assert.throws(()=>x.conversion.authorizeCancellationRetry('400001',{...retryConsent,...patch}),{code:'CONVERSION_CONSENT'});
  }
  await assert.rejects(()=>x.conversion.cancel('400001'),{code:'CONVERSION_UNKNOWN'});
  assert.equal(x.cancels,1);
 }finally{x.journal.close();}
});
