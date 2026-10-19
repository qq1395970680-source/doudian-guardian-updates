import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';

const now=1792410637077;
function setup(){
 const journal=new Journal(':memory:'),rules={noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30};
 const policy={shopId:'900001',excludedProductIds:['3000000000000000002'],allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:false,cutoverConfirmed:false};
 const baselines=[1,2,3].map(n=>({source:'verified-platform-history',complete:true,shopId:policy.shopId,productId:'300000000000000000'+n,name:'商品'+n,campaignId:'400000000000000000'+n,historyAt:now-10000,type:'限时抢购',rules,
  skus:[{id:'500000000000000000'+n,name:'规格'+n,baseFen:10000,discount:60}]}));
 const reads=[],platform={progress:{},inventory:{activeComplete:true},
  loss:async b=>({complete:true,active:b===baselines[2],lossKey:'expired-'+b.productId,observedAt:now}),
  precheck:async b=>{reads.push(b.productId);return {shopId:policy.shopId,productId:b.productId,complete:true,observedAt:now,skus:b.skus};},
  prepare:()=>{throw Error('Read-only preview must not prepare')},submit:()=>{throw Error('Read-only preview must not submit')}};
 for(const b of baselines)journal.remember(b,now);
 // histories() returns detached values, so compare by ID in the fixture.
 platform.loss=async b=>({complete:true,active:b.productId===baselines[2].productId,lossKey:'expired-'+b.productId,observedAt:now});
 const service=new GuardianService({journal,platform,policy,now:()=>now});return {journal,service,platform,reads,baselines};
}
test('read-only preflight evaluates all historical products with no task enqueue or write',async()=>{
 const f=setup();try{const r=await f.service.preview();assert.equal(r.readOnly,true);assert.equal(r.products.length,3);
  assert.deepEqual(r.products.map(p=>p.status).sort(),['active','eligible','excluded']);assert.equal(r.products.find(p=>p.status==='eligible').skuCount,1);
  assert.deepEqual(f.reads,[f.baselines[0].productId]);assert.equal(f.journal.list('900001').length,0);assert.equal(f.service.running,false);
 }finally{f.journal.close();}
});
test('incomplete active inventory blocks preflight before any product selection',async()=>{
 const f=setup();try{f.platform.inventory.activeComplete=false;await assert.rejects(f.service.preview(),{code:'ACTIVE_UNKNOWN'});assert.equal(f.reads.length,0);assert.equal(f.journal.list('900001').length,0);}finally{f.journal.close();}
});
test('changed original price stays a blocked result without enabling writes',async()=>{
 const f=setup();try{f.platform.precheck=async b=>({shopId:'900001',productId:b.productId,complete:true,observedAt:now,skus:b.skus.map(s=>({...s,baseFen:11000}))});
  const r=await f.service.preview();assert.equal(r.products.find(p=>p.productId===f.baselines[0].productId).code,'BASE_PRICE_CHANGED');assert.equal(f.journal.list('900001').length,0);
 }finally{f.journal.close();}
});
