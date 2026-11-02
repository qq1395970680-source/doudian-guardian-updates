import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {hiddenInactiveProductIds} from '../src/catalog-visibility.mjs';
import {workspaceOwnership} from '../src/workspace-ownership.mjs';
import {careServiceFixture} from './helpers/care-service-fixture.mjs';

function seed(j,f,code='OFF_SHELF'){
 const shopId=f.policy.shopId,productId=f.baseline.productId,at=f.now()-1000,productState={shopId,productId,complete:true,observedAt:at,
  source:code==='OFF_SHELF'?'live-platform-product-management':'live-platform-product-recycle',kind:code==='OFF_SHELF'?'off-shelf':'recycled',...(code==='OFF_SHELF'?{status:'已下架'}:{})};
 j.putProductCheck(shopId,productId,{code,at,retryAt:f.now()+86400000,productState});return {code,at,productState};
}
const hidden=(j,f,catalog)=>hiddenInactiveProductIds({shopId:f.policy.shopId,checks:j.productChecks(f.policy.shopId),catalog,now:f.now()});

for(const code of ['OFF_SHELF','PRODUCT_RECYCLED'])test('real service read timeouts retain the last inactive display fact without changing error cooldown or submitting: '+code,async()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j),original=seed(j,f,code);f.platform.loss=async()=>{throw Object.assign(new Error('temporary independent loss read timeout'),{code:'READ_OPERATION_TIMEOUT'});};const service=new GuardianService({journal:j,...f});
  for(let pass=0;pass<2;pass++){
   await service.tick();const check=j.productChecks(f.policy.shopId)[0];assert.equal(check.code,'READ_OPERATION_TIMEOUT');assert.equal(check.at,f.now());assert.equal(check.retryAt,f.now()+60000);assert.equal(check.productState,undefined);assert.deepEqual(check.lastKnownInactive,original);assert.deepEqual(hidden(j,f),[f.baseline.productId]);assert.equal(f.state.submits,0);assert.equal(j.list(f.policy.shopId).length,0);f.advance(60000);
  }
 }finally{j.close();}
});

test('a complete new on-shelf state clears the display marker while older or other-shop states cannot',()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j),original=seed(j,f),shopId=f.policy.shopId,productId=f.baseline.productId;
  j.putProductCheck(shopId,productId,{code:'READ_OPERATION_TIMEOUT',at:f.now(),retryAt:f.now()+60000});
  for(const proof of [{...original.productState,kind:'managed-product-state',status:'售卖中',observedAt:original.productState.observedAt-1},{...original.productState,kind:'managed-product-state',status:'售卖中',shopId:'900002',observedAt:f.now()}]){
   j.putProductCheck(shopId,productId,{code:'PRODUCT_STATE_READ',at:f.now(),retryAt:f.now()+60000,productState:proof});assert.deepEqual(hidden(j,f),[productId]);
  }
  j.putProductCheck(shopId,productId,{code:'PRODUCT_STATE_READ',at:f.now(),retryAt:f.now()+60000,productState:{...original.productState,kind:'managed-product-state',status:'售卖中',observedAt:f.now()}});assert.deepEqual(hidden(j,f),[]);assert.equal(j.productChecks(shopId)[0].lastKnownInactive,undefined);
 }finally{j.close();}
});

test('a fresh complete available precheck removes the overlay before a new lower-price review and never approves that reduction',async()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j,{mixed:true}),loss=f.platform.loss,precheck=f.platform.precheck;seed(j,f);f.platform.loss=async()=>{throw Object.assign(new Error('one network timeout'),{code:'READ_OPERATION_TIMEOUT'});};
  const service=new GuardianService({journal:j,...f});await service.tick();assert.deepEqual(hidden(j,f),[f.baseline.productId]);
  f.platform.loss=loss;f.platform.precheck=async baseline=>({...await precheck(baseline),offShelf:false,skus:baseline.skus.map(s=>({...s,id:null,idSource:'unavailable-in-create-form'}))});f.advance(60000);await service.tick();
  const review=j.priceReviews(f.policy.shopId).find(r=>r.status==='pending');assert.ok(review);assert.ok(review.rows.some(row=>row.saleFen<row.previousFen));assert.equal(j.priceTarget(f.policy.shopId,f.baseline.productId),null);assert.equal(f.state.submits,0);assert.deepEqual(hidden(j,f),[]);
  const owner=workspaceOwnership({shopId:f.policy.shopId,reviews:j.priceReviews(f.policy.shopId),tasks:j.list(f.policy.shopId),checks:j.productChecks(f.policy.shopId),careEnabled:true,now:f.now()});assert.equal(owner.byProduct.get(f.baseline.productId).owner,'prices');assert.ok(j.events(50).some(e=>e.kind==='inactive-display-cleared-by-precheck'));
 }finally{j.close();}
});

test('remembered inactive evidence does not cross shops or products and cannot be injected with a later error',()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j),proof=seed(j,f),productId=f.baseline.productId;j.putProductCheck(f.policy.shopId,productId,{code:'LOAD_TIMEOUT',at:f.now()});
  for(const [shopId,pid] of [['900002',productId],[f.policy.shopId,'3500000000000000099']]){j.putProductCheck(shopId,pid,{code:'LOAD_TIMEOUT',at:f.now(),lastKnownInactive:proof});const check=j.productChecks(shopId).find(c=>c.productId===pid);assert.equal(check.lastKnownInactive,undefined);assert.deepEqual(hiddenInactiveProductIds({shopId,checks:[check],now:f.now()}),[]);}
  assert.deepEqual(hidden(j,f),[productId]);
 }finally{j.close();}
});

test('new activity, scheduled membership and unresolved or ambiguous records override the display overlay without changing it',()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j);seed(j,f);j.putProductCheck(f.policy.shopId,f.baseline.productId,{code:'LOAD_TIMEOUT',at:f.now(),retryAt:f.now()+60000});const before=structuredClone(j.productChecks(f.policy.shopId));
  for(const patch of [{current:[{}]},{scheduled:[{}]},{pending:true},{ambiguous:true}])assert.deepEqual(hidden(j,f,{products:[{productId:f.baseline.productId,current:[],scheduled:[],...patch}]}),[]);
  assert.deepEqual(j.productChecks(f.policy.shopId),before);assert.deepEqual(hidden(j,f),[f.baseline.productId]);j.clearProductCheck(f.policy.shopId,f.baseline.productId);assert.deepEqual(hidden(j,f),[]);
 }finally{j.close();}
});

test('display clearing rejects stale, incomplete, cross-scope or unavailable prechecks and preserves an ordinary current error',()=>{
 const j=new Journal(':memory:');try{
  const f=careServiceFixture(j),shopId=f.policy.shopId,productId=f.baseline.productId;seed(j,f);j.putProductCheck(shopId,productId,{code:'LOAD_TIMEOUT',at:f.now(),retryAt:f.now()+60000});const before=structuredClone(j.productChecks(shopId)[0]);
  const valid={...f.baseline,complete:true,offShelf:false,observedAt:f.now(),skus:f.baseline.skus.map(s=>({...s,id:null,idSource:'unavailable-in-create-form'}))};
  for(const patch of [{shopId:'900002'},{productId:'3500000000000000099'},{complete:false},{offShelf:true},{offShelf:undefined},{observedAt:f.now()-30001},{observedAt:f.now()+1},{skus:[]},{skus:[null]},{skus:[{...valid.skus[0],idSource:'unknown'}]},{skus:[{...valid.skus[0],baseFen:0}]},{skus:[valid.skus[0],valid.skus[0]]}]){assert.equal(j.clearInactiveDisplayAfterPrecheck(shopId,productId,{...valid,...patch},f.now()),false);assert.deepEqual(j.productChecks(shopId)[0],before);}
  assert.equal(j.clearInactiveDisplayAfterPrecheck(shopId,productId,valid,f.now()),true);const after=j.productChecks(shopId)[0];assert.equal(after.code,before.code);assert.equal(after.at,before.at);assert.equal(after.retryAt,before.retryAt);assert.equal(after.lastKnownInactive,undefined);assert.deepEqual(hidden(j,f),[]);
 }finally{j.close();}
});
