import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {GuardError} from '../src/policy.mjs';
import {fingerprint} from '../src/policy.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {ratioFixture,ratioNow as now} from './helpers/ratio-review-fixture.mjs';
test('complete current absence with unproven exit reaches exact rebuild confirmation and requires explicit quantity consent',async()=>{
 const j=new Journal(':memory:');
 try{
  const f=ratioFixture(j),detail={referenceCampaignId:f.baseline.campaignId,branch:'risk-removal-unproven',status:'进行中',
   currentAbsence:{source:'live-platform-current-absence',shopId:f.policy.shopId,productId:f.baseline.productId,complete:true,observedAt:now,listingFingerprint:'a'.repeat(64)}};
  const error=()=>new GuardError('LIMITED_LOSS_UNPROVEN','尚无退出证明',{limitedLoss:structuredClone(detail)});
  const platform={discover:async()=>({activeComplete:true,baselines:[]}),loss:async()=>{throw error();},
   lossBatch:async()=>[{productId:f.baseline.productId,error:error()}],precheck:async()=>structuredClone(f.current),precheckBatch:async()=>[structuredClone(f.current)]};
  const s=new GuardianService({journal:j,platform,policy:f.policy,now:()=>now});await s.tick();
  const r=j.priceReviews(f.policy.shopId)[0];assert.ok(r,'A missing product must have a concrete confirmation path rather than a generic repeat error');
  assert.equal(r.kind,'limited-rebuild');assert.equal(r.rows.length,2);assert.equal(r.status,'pending');assert.equal(j.list(f.policy.shopId).length,0);
  assert.equal(r.rebuildTarget.activityLimit,1000);assert.equal(r.rebuildTarget.durationMs,7*86400000);
  const args={reviewId:r.id,key:r.key,decision:'approve',confirmedSkuIds:r.rows.map(x=>x.id),acceptPriceAndRisk:true};
  assert.throws(()=>s.decidePriceReview(args),{code:'REBUILD_CONSENT_REQUIRED'});
  const approved=s.decidePriceReview({...args,confirmRebuild:true});assert.equal(approved.consent.rebuildConfirmed,true);
  assert.equal(j.list(f.policy.shopId).length,0,'Approval is not a platform write or a recovery receipt');
 }finally{j.close();}
});
test('manual rebuild permission binds to the exact source state and activity quantities, not all future missing activities',()=>{
 const j=new Journal(':memory:'),now=Date.now();
 try{
  const f=ratioFixture(j,{now}),platform=new DoudianPlatform({browser:{},policy:f.policy,journal:j});
  const campaign={id:f.baseline.campaignId,type:'限量抢购',name:'原活动',status:'进行中',risk:false,startAt:now-1000,endAt:now+100000};
  const listing={complete:true,observedAt:now,campaigns:[campaign]},details=new Map([[campaign.id,{complete:true,observedAt:now,products:[],rules:f.baseline.rules}]]);
  let failure;try{platform.lossFrom(f.baseline,listing,details,true,true);}catch(error){failure=error;}
  assert.equal(failure.code,'LIMITED_LOSS_UNPROVEN');const review=j.recordRebuildPriceReview(f.plan,failure.detail.limitedLoss,now);
  j.decidePriceReview(f.policy.shopId,review.id,review.key,'approve',{confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true,confirmRebuild:true,historicalFingerprint:fingerprint(f.baseline)},now);
  const loss=platform.lossFrom(f.baseline,listing,details,true,true);assert.equal(loss.continuity.kind,'confirmed-rebuild');assert.equal(loss.removal,undefined);
  assert.throws(()=>platform.lossFrom(f.baseline,{...listing,campaigns:[{...campaign,status:'已作废'}]},details,true,true),{code:'LIMITED_LOSS_UNPROVEN'},'A changed source state needs new explicit consent');
  const altered={...f.plan,activityLimit:999,priceApprovalId:review.id,priceApprovalKey:review.key};
  assert.throws(()=>j.assertPricePlans(f.policy.shopId,[altered]),{code:'REBUILD_CONSENT_REQUIRED'});
 }finally{j.close();}
});
