import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {GuardianService} from '../src/service.mjs';

function fixture(t,count=46){
 let clock=1793099000000;
 t.mock.method(Date,'now',()=>clock);
 const journal=new Journal(':memory:');
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true,excludedProductIds:[]};
 const baselines=Array.from({length:count},(_,i)=>({source:'verified-platform-history',complete:true,shopId:policy.shopId,
  productId:String(3500000000000000100n+BigInt(i)),name:'已有活动的守护商品'+i,campaignId:String(4500000000000000100n+BigInt(i)),
  type:'限时抢购',durationMs:172800000,historyAt:clock-60000,
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},
  skus:[{id:String(5500000000000000100n+BigInt(i)),name:'原规格',baseFen:10000,discount:50}]}));
 for(const b of baselines)journal.remember(b,clock);
 const campaigns=baselines.map(b=>({id:b.campaignId,name:'现有活动'+b.productId,type:b.type,status:'进行中',startAt:clock-60000,endAt:clock+172740000,risk:false}));
 const details=new Map(baselines.map(b=>[b.campaignId,{complete:true,observedAt:clock-600000,rules:b.rules,
  products:[{productId:b.productId,skus:b.skus,removalConfirmed:false,removalAmbiguous:false}]}]));
 const platform=new DoudianPlatform({browser:{},policy,journal});
 platform.inventory={listing:{complete:true,observedAt:clock-600000,campaigns:structuredClone(campaigns)},details,activeComplete:true};
 const reads={legacyLossBatch:0,currentLists:0,details:[]};
 platform.precheck=async()=>{throw Object.assign(new Error('商品已有有效活动'),{code:'ALREADY_ACTIVE'});};
 platform.precheckBatch=platform.precheck;
 platform.listActive=async()=>{reads.currentLists++;clock+=1000;return{complete:true,observedAt:clock,campaigns:structuredClone(campaigns)};};
 platform.detail=async c=>{reads.details.push(c.id);clock+=3000;return{...structuredClone(details.get(c.id)),observedAt:clock};};
 platform.lossBatch=async bs=>{
  reads.legacyLossBatch++;
  return bs.map(b=>{clock+=10000;return{productId:b.productId,loss:{complete:true,active:true,ambiguous:false,observedAt:clock,campaignId:b.campaignId}};});
 };
 const service=new GuardianService({journal,platform,policy,immediate:true});
 service.canRunImmediate=()=>false;
 return{journal,platform,service,baselines,campaigns,details,reads,now:()=>clock,advance:ms=>{clock+=ms;}};
}

test('46 already-active products are concluded from fresh independent campaign reads without expiring earlier members or submitting',async t=>{
 const f=fixture(t),blocked=[];
 try{
  f.service.requestRecovery(f.baselines.map(b=>b.productId));
  await f.service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>{
   blocked.push({productId:member.baseline.productId,code:error.code});
   f.journal.putProductCheck(f.service.policy.shopId,member.baseline.productId,{code:error.code,at:f.now(),retryAt:f.now()+900000});
  });
  assert.deepEqual(blocked,[],'earlier positive reads must not become ACTIVE_HINT_UNVERIFIED while waiting for unrelated later products');
  assert.equal(f.journal.priceRecheckProgress(f.service.policy.shopId).pending,0);
  const page=f.journal.priceRecheckProgress(f.service.policy.shopId),records=[];
  assert.equal(page.total,46);
  for(let p=0;p<page.pages;p++)records.push(...f.journal.priceRecheckProgress(f.service.policy.shopId,{page:p}).records);
  assert.equal(records.length,46);assert.ok(records.every(r=>r.state==='checked'&&!r.taskId));
  assert.equal(f.reads.legacyLossBatch,0,'known current campaign lookup avoids 46 independent product-filtered list scans');
  assert.equal(new Set(f.reads.details).size,46);
  assert.equal(f.journal.list(f.service.policy.shopId).length,0,'existing-activity checks cannot enqueue or submit a recovery');
 }finally{f.service.stop();f.journal.close();}
});

test('many requested products in the same known activity share one new detail read',async t=>{
 const f=fixture(t,20),blocked=[];
 try{
  const first=f.campaigns[0],products=[...f.details.values()].flatMap(d=>d.products);
  f.campaigns.splice(1);f.details.clear();f.details.set(first.id,{complete:true,observedAt:f.now()-600000,products});
  f.service.requestRecovery(f.baselines.map(b=>b.productId));
  await f.service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>blocked.push(error.code));
  assert.deepEqual(blocked,[]);assert.deepEqual(f.reads.details,[first.id]);assert.equal(f.reads.legacyLossBatch,0);
  assert.equal(f.journal.priceRecheckProgress(f.service.policy.shopId).pending,0);assert.equal(f.journal.list(f.service.policy.shopId).length,0);
 }finally{f.service.stop();f.journal.close();}
});

for(const mode of ['removed','ambiguous','disappeared','stale'])test('new active-membership reads preserve a blocked request when proof is '+mode,async t=>{
 const f=fixture(t,1),blocked=[];
 try{
  const d=f.details.get(f.campaigns[0].id);
  if(mode==='removed')d.products[0].removalConfirmed=true;
  if(mode==='ambiguous')d.products[0].removalAmbiguous=true;
  if(mode==='disappeared'){
   const list=f.platform.listActive;let calls=0;
   f.platform.listActive=async()=>{const result=await list();if(++calls>1)result.campaigns=[];return result;};
  }
  if(mode==='stale')f.platform.detail=async c=>({...structuredClone(f.details.get(c.id)),observedAt:f.now()-180000});
  f.platform.lossBatch=async bs=>bs.map(b=>({productId:b.productId,loss:{complete:true,active:mode!=='removed'&&mode!=='disappeared',
   ambiguous:mode==='ambiguous',campaignId:b.campaignId,observedAt:mode==='stale'?f.now()-180000:f.now()}}));
  f.service.requestRecovery(f.baselines.map(b=>b.productId));
  await f.service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>{
   blocked.push(error.code);f.journal.putProductCheck(f.service.policy.shopId,member.baseline.productId,{code:error.code,at:f.now(),retryAt:f.now()+900000});
  });
  assert.deepEqual(blocked,['ACTIVE_HINT_UNVERIFIED']);assert.equal(f.journal.priceRecheckProgress(f.service.policy.shopId).pending,1);
  assert.equal(f.journal.list(f.service.policy.shopId).length,0);
 }finally{f.service.stop();f.journal.close();}
});

test('a malformed streamed product set cannot conclude an unrelated request',async t=>{
 const f=fixture(t,1),blocked=[];
 try{
  f.platform.confirmActiveHintBatches=async function*(){yield[{productId:'3999999999999999999',loss:{complete:true,active:true,campaignId:f.campaigns[0].id,observedAt:f.now()}}];};
  f.service.requestRecovery(f.baselines.map(b=>b.productId));
  await f.service.recoverBatch(f.baselines.map(baseline=>({baseline})),(member,error)=>{
   blocked.push(error.code);f.journal.putProductCheck(f.service.policy.shopId,member.baseline.productId,{code:error.code,at:f.now(),retryAt:f.now()+900000});
  });
  assert.deepEqual(blocked,['ACTIVE_HINT_UNVERIFIED']);assert.equal(f.journal.priceRecheckProgress(f.service.policy.shopId).pending,1);
  assert.equal(f.journal.list(f.service.policy.shopId).length,0);
 }finally{f.service.stop();f.journal.close();}
});

test('a slow unrelated detail causes a fresh read of only expired positive sources before acceptance',async t=>{
 const f=fixture(t,7),seen=[];
 try{
  const detail=f.platform.detail;let delayed=false;
  f.platform.detail=async c=>{const result=await detail(c);if(!delayed&&c.id===f.campaigns[5].id){delayed=true;f.advance(150000);}return result;};
  for await(const proofs of f.platform.confirmActiveHintBatches(f.baselines)){
   for(const p of proofs){assert.equal(p.loss?.active,true);assert.ok(f.now()-p.loss.observedAt<=120000);seen.push(p.productId);}
  }
  assert.deepEqual(seen.sort(),f.baselines.map(b=>b.productId).sort());
  assert.ok(f.reads.details.length>7);assert.equal(f.reads.legacyLossBatch,0);assert.equal(f.journal.list(f.service.policy.shopId).length,0);
 }finally{f.service.stop();f.journal.close();}
});

for(const code of ['SHOP_MISMATCH','STOPPED'])test('active-membership verification propagates '+code+' without completing requests',async t=>{
 const f=fixture(t,1);
 try{
  f.platform.listActive=async()=>{throw Object.assign(new Error('Independent read refused'),{code});};
  f.service.requestRecovery(f.baselines.map(b=>b.productId));
  await assert.rejects(f.service.recoverBatch(f.baselines.map(baseline=>({baseline})),()=>assert.fail('fatal reads must not become an ordinary per-product retry')),{code});
  assert.equal(f.journal.priceRecheckProgress(f.service.policy.shopId).pending,1);assert.equal(f.journal.list(f.service.policy.shopId).length,0);
 }finally{f.service.stop();f.journal.close();}
});
