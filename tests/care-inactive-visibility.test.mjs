import test from 'node:test';
import assert from 'node:assert/strict';
import {blockerFixture} from './helpers/blocker-prices-fixture.mjs';
import {recoveryRequests} from '../src/recovery-requests.mjs';

async function enableFixtureExecution(x){
 // Exercise the real API policy gate while keeping this in-memory fixture's
 // patrol timer stopped; the test inspects only persisted recovery requests.
 x.service.start=()=>{};Object.assign(x.service.policy,{liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true});
 assert.equal((await x.post('start',{shopId:x.review.shopId})).status,202);
}

for(const code of ['OFF_SHELF','PRODUCT_RECYCLED'])test('enabling care retains the exact inactive proof even when the pending review would add the product back: '+code,async()=>{
 const x=await blockerFixture();try{
  await enableFixtureExecution(x);const shopId=x.review.shopId,productId=x.review.productId,now=Date.now();
  const productState={source:code==='OFF_SHELF'?'live-platform-product-management':'live-platform-product-recycle',kind:code==='OFF_SHELF'?'off-shelf':'recycled',...(code==='OFF_SHELF'?{status:'已下架'}:{}),shopId,productId,complete:true,observedAt:now-2*86400000};
  x.journal.putProductCheck(shopId,productId,{code,message:'独立核实已下架或回收，历史仍保留',at:now-86400000,retryAt:now+3600000,productState});
  const row=()=>x.journal.db.prepare('SELECT body FROM product_checks WHERE shop=? AND product=?').get(shopId,productId)?.body,before=row();
  const catalog=async()=>(await(await fetch(x.app.url+'/api/products')).json()).products;
  assert.equal((await catalog()).some(p=>p.productId===productId),false);assert.equal(x.journal.priceReview(x.review.id).status,'pending');
  const response=await x.post('care-recovery-policy',{shopId,enabled:true,acceptNonReducingRecovery:true});assert.equal(response.status,200,await response.clone().text());
  assert.equal(row(),before,'proof body, original at and retryAt must stay byte-for-byte unchanged');assert.equal((await catalog()).some(p=>p.productId===productId),false);
  assert.equal((await(await fetch(x.app.url+'/api/price-reviews?scope=pending')).json()).total,0);assert.equal((await(await fetch(x.app.url+'/api/recovery-blockers')).json()).total,0);
  assert.equal(recoveryRequests(x.journal,shopId).items.some(r=>r.productId===productId),false);assert.equal(x.journal.priceReview(x.review.id).status,'pending','historical suggestion is preserved in storage');assert.equal(x.journal.histories(shopId).length,1);assert.equal(x.journal.list(shopId).reduce((sum,t)=>sum+t.submitAttempts,0),0);
 }finally{await x.close();}
});

test('enabling care still clears a normal restore blocker and wakes its recovery request',async()=>{
 const x=await blockerFixture();try{
  await enableFixtureExecution(x);const shopId=x.review.shopId,productId=x.review.productId;x.journal.putProductCheck(shopId,productId,{code:'RESTORE_BLOCKED',message:'等待按新授权重新核验',at:Date.now()-1000,retryAt:Date.now()+900000});
  const response=await x.post('care-recovery-policy',{shopId,enabled:true,acceptNonReducingRecovery:true});assert.equal(response.status,200);
  assert.equal(x.journal.productChecks(shopId).some(c=>c.productId===productId),false);assert.equal(recoveryRequests(x.journal,shopId).items.filter(r=>r.productId===productId&&r.state==='pending').length,1);assert.equal(x.journal.list(shopId).reduce((sum,t)=>sum+t.submitAttempts,0),0);
 }finally{await x.close();}
});
