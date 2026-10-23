import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {GuardianService} from '../../src/service.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';

for(const count of [1,10,11,26,50])test(`native 10-per-page form precheck reads ${count} products with complete virtual SKU coverage`,{timeout:180000},async()=>{
 const products=Array.from({length:count},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'分页商品'+i,
  skus:Array.from({length:i%3+3},(_,j)=>({id:String(5000000000000000000n+BigInt(i*10+j)),name:'规格'+j,baseFen:10000+i*10+j,discount:82}))}));
 const fixture=await fixtureServer({catalogProducts:products,formPageSize:10}),dir=await mkdtemp(join(tmpdir(),'guardian-form-paging-'));
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'tasks.sqlite'));
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  const values=await platform.precheckBatch(products.map(p=>({...p,shopId:'900001'})));
  assert.equal(values.length,count);for(const value of values){const p=products.find(p=>p.productId===value.productId);assert.deepEqual(value.skus.map(s=>[s.name,s.baseFen]),p.skus.map(s=>[s.name,s.baseFen]));}
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
  const d=journal.events(10).find(e=>e.kind==='batch-precheck-verified').detail.precheckMembership;
  assert.deepEqual(d.traversal.completePages,Array.from({length:Math.ceil(count/10)},(_,i)=>i+1));
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('26-product limited draft uses native capacity for complete quota, submit, risk and independent readback',{timeout:180000},async()=>{
 const products=Array.from({length:26},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'分页限量商品'+i,
  skus:Array.from({length:i<18?10:9},(_,j)=>({id:String(5000000000000000000n+BigInt(i*10+j)),name:'规格'+j,baseFen:10000+i*10+j,discount:82}))}));
 const fixture=await fixtureServer({catalogProducts:products,formPageSize:10,limited:true,detailObservedPrices:true});
 const dir=await mkdtemp(join(tmpdir(),'guardian-paged-limited-')),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true},platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 try{
  const plans=products.map(p=>{const b={...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',campaignId:'4000000000000000001',durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}};journal.remember(b);return planOriginalRestore(b,{...b,observedAt:Date.now()},policy);});
  const task=journal.enqueue(policy.shopId,plans,{complete:true,observedAt:Date.now(),lossKey:'local-paged-limited'});journal.lease(policy.shopId,service.owner,Date.now(),300000);await service.execute(task);
  const result=journal.get(task.id);assert.equal(result.phase,'verified',result.reason);assert.equal(result.receipt.productCount,26);assert.equal(result.receipt.skuCount,252);
  assert.equal(fixture.state.uploads,1);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.risks,1);assert.equal(fixture.state.formPageSizeChanges,1);
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

for(const fault of ['duplicate-page','no-advance'])test(`unreliable form pagination ${fault} blocks with zero submissions`,{timeout:90000},async()=>{
 const products=Array.from({length:11},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'异常分页商品'+i,
  skus:[{id:String(5000000000000000000n+BigInt(i)),name:'唯一规格',baseFen:10000,discount:82}]}));
 const fixture=await fixtureServer({catalogProducts:products,formPageSize:10,formPagerFault:fault}),dir=await mkdtemp(join(tmpdir(),'guardian-page-fault-'));
 const browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(':memory:'),platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  await assert.rejects(platform.precheckBatch(products.map(p=>({...p,shopId:'900001'}))),{code:fault==='duplicate-page'?'PRODUCT_DUPLICATE':'FORM_PAGING_STALLED'});
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(journal.list('900001').length,0);
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('live 10-product capacity without enlargement regroups 26 products only before submission and refreshes child proofs',{timeout:240000},async()=>{
 const products=Array.from({length:26},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'实时容量商品'+i,
  skus:[{id:String(5000000000000000000n+BigInt(i)),name:'唯一规格',baseFen:10000,discount:82}]}));
 const fixture=await fixtureServer({catalogProducts:products,formPageSize:10,formPageSizeOptions:[],limited:true,detailObservedPrices:true}),dir=await mkdtemp(join(tmpdir(),'guardian-capacity-'));
 const browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,journal,policy,base:fixture.base}),service=new GuardianService({platform,journal,policy});
 const start=Math.floor(Date.now()/1000)*1000,original=fixture.state.campaigns[0];
 Object.assign(original,{type:'限量抢购',status:'进行中',risk:true,autoRenew:true,startAt:start-100000,endAt:start-100000+7*86400000,products:[],
  removals:products.map(p=>({...p,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}))});
 const baselines=products.map(p=>({...p,shopId:policy.shopId,source:'verified-platform-history',complete:true,type:'限量抢购',campaignId:original.id,
  durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}}));
 try{
  for(const b of baselines)journal.remember(b);journal.lease(policy.shopId,service.owner,Date.now(),300000);
  const errors=[];await service.recoverBatch(baselines.map(baseline=>({baseline})),(m,e)=>errors.push(e));
  assert.deepEqual(errors,[]);const tasks=journal.list(policy.shopId),parent=tasks.find(t=>t.plans.length===26);
  assert.equal(parent.phase,'blocked');assert.equal(parent.submitAttempts,0);assert.match(parent.reason,/FORM_BATCH_CAPACITY/);
  const verified=tasks.filter(t=>t.phase==='verified');assert.deepEqual(verified.map(t=>t.plans.length).sort((a,b)=>a-b),[6,10,10]);
  assert.equal(verified.reduce((n,t)=>n+t.receipt.productCount,0),26);assert.equal(fixture.state.submits,3);assert.equal(fixture.state.risks,3);
  assert.equal(journal.events(1000).filter(e=>e.kind==='batch-capacity-regrouped').length,1);
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
