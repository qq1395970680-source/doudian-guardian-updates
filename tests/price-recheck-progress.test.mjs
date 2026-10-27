import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {ratioFixture} from './helpers/ratio-review-fixture.mjs';
import {recoveryRequests,updateRecoveryRequest,requestRecovery,pauseRecoveryRequests} from '../src/recovery-requests.mjs';
import {buildRecheckProgress} from '../src/recheck-progress.mjs';
import {recoveryTask} from './helpers/recovery-fixture.mjs';

function recalculated(j,now=Date.now()){
 const f=ratioFixture(j,{now}),review=j.recordRemovalPriceReview(f.plan,f.loss,now);
 j.decidePriceReview(f.policy.shopId,review.id,review.key,'recalculate',{queueRecovery:true},now+1);
 return{...f,review,now:now+1,request:recoveryRequests(j,f.policy.shopId).items[0]};
}
test('recalculate keeps a visible durable progress row after the old price proposal leaves the pending list',()=>{
 const j=new Journal(':memory:');try{
  const f=recalculated(j),page=j.priceReviewPage(f.policy.shopId,{direction:'increase'});
  assert.equal(page.pending,0);assert.equal(j.priceReview(f.review.id).status,'superseded');
  assert.equal(page.rechecks?.pending,1);assert.equal(page.rechecks.records[0].productId,f.baseline.productId);
  assert.equal(page.rechecks.records[0].sourceReviewId,f.review.id);assert.equal(page.rechecks.records[0].state,'queued');
  assert.equal(j.priceTarget(f.policy.shopId,f.baseline.productId),null);assert.equal(j.list(f.policy.shopId).length,0);
 }finally{j.close();}
});

test('paused and retrying requests keep their source review and cannot create price consent',()=>{
 const j=new Journal(':memory:');try{
  const f=recalculated(j);pauseRecoveryRequests(j,f.policy.shopId,true);
  assert.equal(j.priceRecheckProgress(f.policy.shopId).records[0].state,'paused');
  requestRecovery(j,f.policy.shopId,[{productId:f.baseline.productId}],'user-recheck',f.now+10);
  const row=j.priceRecheckProgress(f.policy.shopId).records[0];assert.equal(row.state,'queued');assert.equal(row.sourceReviewId,f.review.id);
  assert.equal(j.priceTarget(f.policy.shopId,f.baseline.productId),null);
  assert.equal(j.priceRecheckProgress('900002').total,0);assert.equal(j.priceRecheckProgress(null).total,0);
 }finally{j.close();}
});

test('completed checks only claim recovery when a matching post-request independent receipt exists',()=>{
 const now=Date.now(),task=recoveryTask(),request={id:'request',productId:task.plans[0].productId,state:'complete',requestedAt:now-1000,updatedAt:now,reason:'当前有效活动或恢复结果已核实'};
 const view=(tasks,entry=request)=>buildRecheckProgress({shopId:'900001',queue:{recent:[entry]},tasks}).records[0];
 assert.equal(view([task]).state,'verified');assert.equal(view([task]).skuCount,2);
 const old=structuredClone(task);old.receipt.verifiedAt=now-2000;assert.equal(view([old]).state,'checked');
 const broken=structuredClone(task);broken.receipt.skuCount=99;assert.equal(view([broken]).state,'checked');
 const unknown={...task,phase:'unknown'};assert.equal(view([unknown],{...request,state:'pending'}).state,'verifying');
 assert.equal(view([{...task,shopId:'900002'}]).state,'checked');
});

test('large recheck queues paginate without losing failure records or changing execution state',()=>{
 const now=Date.now(),queue={items:Array.from({length:501},(_,i)=>({id:'r'+i,productId:String(300000+i),state:'deferred',requestedAt:now,updatedAt:now,code:'PRECHECK_MEMBERSHIP',reason:'完整商品集合核对失败'}))};
 const before=structuredClone(queue),page=buildRecheckProgress({shopId:'900001',queue,page:50,pageSize:10});
 assert.equal(page.pending,501);assert.equal(page.total,501);assert.equal(page.records.length,1);assert.equal(page.records[0].code,'PRECHECK_MEMBERSHIP');assert.deepEqual(queue,before);
});

test('explicitly recycled or off-shelf conclusions stay visible without falsely requiring price action',()=>{
 const now=Date.now();for(const code of ['PRODUCT_RECYCLED','OFF_SHELF']){
  const queue={items:[{id:'skipped',productId:'300001',state:'deferred',requestedAt:now-100,updatedAt:now,code,reason:'平台已明确下架或回收'}]};
  const view=buildRecheckProgress({shopId:'900001',queue});assert.equal(view.pending,0);assert.equal(view.records[0].state,'skipped');assert.equal(view.records[0].code,code);
 }
});
test('a failed recheck stays visible with its exact failure rather than disappearing with no replacement proposal',()=>{
 const j=new Journal(':memory:');try{
  const f=recalculated(j),message='批量预查商品集合不一致：目标20件，实际19件';
  updateRecoveryRequest(j,f.policy.shopId,f.request,{state:'deferred',reason:message},f.now+10);
  j.putProductCheck(f.policy.shopId,f.baseline.productId,{code:'PRECHECK_MEMBERSHIP',message,at:f.now+10});
  const view=j.priceReviewPage(f.policy.shopId,{direction:'increase'}).rechecks;
  assert.equal(view?.pending,1);assert.equal(view.records[0].state,'blocked');assert.equal(view.records[0].code,'PRECHECK_MEMBERSHIP');assert.equal(view.records[0].message,message);
 }finally{j.close();}
});
test('completed recheck conclusions survive restart while a later new proposal replaces the old progress row',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-recheck-progress-')),path=join(dir,'journal.sqlite');let j=new Journal(path);
 try{
  const f=recalculated(j);updateRecoveryRequest(j,f.policy.shopId,f.request,{state:'complete',reason:'当前有效活动或恢复结果已核实'},f.now+10);
  assert.equal(recoveryRequests(j,f.policy.shopId).items.length,0);j.close();j=new Journal(path);
  const result=j.priceReviewPage(f.policy.shopId,{direction:'increase'}).rechecks;
  assert.ok(result?.records.length,'The conclusion must remain available after queue removal and restart');assert.equal(result.pending,0);assert.equal(result.records[0].state,'checked');
  j.recordRemovalPriceReview(f.plan,f.loss,f.now+20);
  const next=j.priceReviewPage(f.policy.shopId,{direction:'increase'});assert.equal(next.pending,1);assert.equal(next.rechecks.records.length,0);
 }finally{j.close();await rm(dir,{recursive:true,force:true});}
});
