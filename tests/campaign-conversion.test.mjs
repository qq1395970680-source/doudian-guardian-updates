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

test('conversion refuses an over-budget full product before cancelling its valid activity and preserves every historical SKU',async()=>{
 const x=example();try{
  x.detail.products[0].skus=Array.from({length:501},(_,i)=>({id:String(500001+i),name:'规格'+i,baseFen:10000+i,discount:60,saleFen:Math.ceil((10000+i)*0.6)}));
  await assert.rejects(()=>x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'capacity-test'}),{code:'RESTORE_SKU_BUDGET'});
  assert.equal(x.cancels,0);assert.equal(x.campaign.status,'进行中');assert.equal(x.conversion.state(),null);assert.equal(x.journal.histories('900001')[0].skus.length,501);
 }finally{x.journal.close();}
});
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

test('a stale cancellation page is reconciled by a fresh read without repeating confirmation',async()=>{
 const x=example();let confirms=0;
 try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  x.platform.cancelCampaign=async(_c,before)=>{
   await before('intent');await before('confirm');confirms++;x.campaign.status='已失效';
   throw Object.assign(Error('original list row did not refresh'),{code:'LOAD_TIMEOUT'});
  };
  const result=await x.conversion.cancel('400001');
  assert.equal(result.phase,'cancelled');assert.equal(result.endedStatus,'已失效');
  assert.equal(result.confirmAttempts,1);assert.equal(confirms,1);
  await x.conversion.cancel('400001');assert.equal(confirms,1);
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

test('five-product conversion bounds independent prechecks to two readers and preserves plan order',async()=>{
 const x=example();let readers=0,peak=0,ensured=0,writes=0;
 const p=x.detail.products[0];
 x.detail.products=Array.from({length:5},(_,i)=>({...structuredClone(p),productId:String(300001+i),skus:p.skus.map(s=>({...s,id:String(500001+i)}))}));
 x.platform.ensure=async()=>{ensured++;};
 x.platform.precheck=async b=>{
  assert.equal(ensured,1,'initialize the shared dedicated browser before concurrent pages');
  readers++;peak=Math.max(peak,readers);
  try{await new Promise(r=>setTimeout(r,b.productId==='300001'?25:5));return{...b,observedAt:Date.now()};}
  finally{readers--;}
 };
 x.conversion.service.execute=async task=>{
  assert.equal(readers,0,'all readers must close before a creation');
  assert.deepEqual(task.plans.map(p=>p.productId),x.detail.products.map(p=>p.productId));
  writes++;
 };
 try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  await x.conversion.cancel('400001');
  const task=await x.conversion.restore(x.detail.products.map(p=>p.productId));
  assert.equal(peak,2);assert.equal(readers,0);assert.equal(writes,1);assert.equal(task.plans.length,5);
 }finally{x.journal.close();}
});

test('a failed parallel precheck drains its other reader and never queues a partial batch',async()=>{
 const x=example();let readers=0,finished=0;
 const p=x.detail.products[0];
 x.detail.products=[p,{...structuredClone(p),productId:'300002',skus:p.skus.map(s=>({...s,id:'500002'}))}];
 x.platform.ensure=async()=>{};
 x.platform.precheck=async b=>{
  readers++;
  try{
   await new Promise(r=>setTimeout(r,b.productId==='300001'?1:25));
   if(b.productId==='300001')throw Object.assign(Error('shop changed'),{code:'SHOP_MISMATCH'});
   finished++;return{...b,observedAt:Date.now()};
  }finally{readers--;}
 };
 x.conversion.service.execute=async()=>assert.fail('an incomplete parallel precheck must not create');
 try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});await x.conversion.cancel('400001');
  await assert.rejects(()=>x.conversion.restore(['300001','300002']),{code:'SHOP_MISMATCH'});
  assert.equal(readers,0);assert.equal(finished,1,'drain the other read before propagating failure');assert.equal(x.journal.list('900001').length,0);
 }finally{x.journal.close();}
});

test('fifty-product migration uses one batch precheck and one shared current inventory after cancellation',async()=>{
 const x=example();let prechecks=0,inventories=0,writes=0;
 const p=x.detail.products[0];x.detail.products=Array.from({length:50},(_,i)=>({...structuredClone(p),productId:String(300001+i),skus:p.skus.map(s=>({...s,id:String(500001+i)}))}));
 x.platform.precheck=async()=>assert.fail('must use a shared form');
 x.platform.precheckBatch=async bs=>{prechecks++;return bs.map(b=>({...b,observedAt:Date.now()}));};
 x.platform.readFreshCurrentInventory=async()=>{inventories++;return{listing:{complete:true,campaigns:[]},details:new Map(),observedAt:Date.now()};};
 x.conversion.service.execute=async task=>{writes++;assert.equal(task.plans.length,50);};
 try{
  await x.conversion.capture(target,{confirmed:true,source:'human-request',requestId:'test'});
  await assert.rejects(()=>x.conversion.restore(x.detail.products.map(p=>p.productId)),{code:'CONVERSION_ACTIVE'});
  assert.equal(prechecks,0);assert.equal(writes,0);
  await x.conversion.cancel('400001');await x.conversion.restore(x.detail.products.map(p=>p.productId));
  assert.equal(prechecks,1);assert.equal(inventories,1);assert.equal(writes,1);
 }finally{x.journal.close();}
});
