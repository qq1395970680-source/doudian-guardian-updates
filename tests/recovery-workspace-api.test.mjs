import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryWorkspaceApp} from './helpers/recovery-workspace-app.mjs';
import {makeDualActivityDecision} from '../src/dual-activity-recovery.mjs';
import {recoveryRequests} from '../src/recovery-requests.mjs';

test('workspace has one confirmation per product only after both independent schemes require reductions',async()=>{
 const x=await recoveryWorkspaceApp();try{
  const list=await x.get('recovery-workspace?scope=confirm'),automatic=await x.get('recovery-workspace?scope=automatic');
  assert.equal(list.total,1);assert.equal(automatic.total,0);assert.equal(list.records[0].productId,x.plan.productId);assert.equal(list.records[0].approvalAllowed,true);
  assert.deepEqual(list.records[0].schemes.map(s=>s.classification),['reduction-required','reduction-required']);assert.equal(list.records[0].reviewId,null);
  assert.equal((await x.get('price-reviews?scope=pending')).total,1,'two independent draft records must not create duplicate price work');
  const detail=await x.get('price-reviews/item?productId='+x.plan.productId);assert.equal(detail.approvalAllowed,true);assert.equal(detail.review.type,x.plan.type);assert.equal(detail.review.dualPairKey,x.decision.pairKey);
  assert.ok(detail.review.options.some(o=>o.available&&o.activityType!==detail.review.type&&o.evidenceReviewId));
  assert.equal(x.state.submits,0);assert.equal(x.journal.priceTarget(x.plan.shopId,x.plan.productId),null);
 }finally{await x.close();}
});

for(const peer of ['non-reducing','pending','unavailable'])test('one reduction and '+peer+' stays automatic and rejects a forged approval',async()=>{
 const caps=peer==='unavailable'?{'限时抢购':5900,'限量抢购':1}:{'限时抢购':5900},x=await recoveryWorkspaceApp({caps});try{
  if(peer==='pending')x.journal.recordDualActivityDecision(makeDualActivityDecision({plan:x.plan,probes:x.probes.slice(0,1),now:Date.now()}));
  const confirm=await x.get('recovery-workspace?scope=confirm'),automatic=await x.get('recovery-workspace?scope=automatic');assert.equal(confirm.total,0);assert.equal(automatic.total,1);assert.equal(automatic.records[0].approvalAllowed,false);
  const detail=await x.get('price-reviews/item?productId='+x.plan.productId);assert.equal(detail.approvalAllowed,false);
  const review=x.journal.priceReviews(x.plan.shopId).find(r=>r.status==='pending');assert.ok(review);
  const response=await x.post('price-reviews/decide',{shopId:x.plan.shopId,reviewId:review.id,key:review.key,dualPairKey:review.dualPairKey,decision:'approve',acceptBlockedPriceChange:true,acceptPriceAndRisk:true,confirmedSkuIds:review.rows.map(r=>r.id)});
  assert.equal(response.status,400);assert.equal(x.journal.priceTarget(x.plan.shopId,x.plan.productId),null);assert.equal(x.state.submits,0);
 }finally{await x.close();}
});

for(const peer of [false,true])test('only the explicitly selected independently checked exact prices are approved: peer='+peer,async()=>{
 const x=await recoveryWorkspaceApp({caps:{'限时抢购':5800,'限量抢购':5900}});try{
  const detail=await x.get('price-reviews/item?productId='+x.plan.productId),r=detail.review,option=r.options.find(o=>o.available&&(o.activityType!==r.type)===peer&&o.id.endsWith('original'))||r.options.find(o=>o.available&&(o.activityType!==r.type)===peer);
  assert.ok(option);const body={shopId:r.shopId,reviewId:r.id,key:r.key,dualPairKey:r.dualPairKey,decision:'approve',acceptBlockedPriceChange:true,acceptPriceAndRisk:true,confirmedSkuIds:r.rows.map(s=>s.id),optionId:option.id,optionKey:option.key};
  const bad=await x.post('price-reviews/decide',{...body,dualPairKey:'stale-pair'});assert.equal(bad.status,400);assert.equal(x.journal.priceTarget(r.shopId,r.productId),null);
  const response=await x.post('price-reviews/decide',body);assert.equal(response.status,202,await response.clone().text());assert.equal((await response.json()).queued,true);assert.equal(x.journal.priceTarget(r.shopId,r.productId),null);assert.equal(x.service.priceApprovalIntent(r.productId).state,'pending');assert.equal(x.state.dualReads.length,0);
  await x.service.revalidateExactPriceIntent(x.baseline);assert.deepEqual([...new Set(x.state.dualReads)].sort(),['限时抢购','限量抢购'].sort());assert.equal(x.state.dualReads.length,2);assert.equal(x.service.priceApprovalIntent(r.productId).state,'approved');const target=x.journal.priceTarget(r.shopId,r.productId);assert.equal(target.type,option.activityType);assert.deepEqual(target.rows.map(s=>s.saleFen),option.rows.map(s=>s.saleFen));assert.equal(x.state.submits,0);
  const history=await x.get('price-reviews/item?productId='+r.productId+'&reviewId='+target.id);assert.equal(history.readOnly,true);assert.equal(history.approvalAllowed,false);assert.equal(history.review.manualEditable,false);assert.equal(history.canRecalculate,false);
 }finally{await x.close();}
});

for(const code of ['OFF_SHELF','PRODUCT_RECYCLED'])test('dual policy retains the original inactive proof across enable: '+code,async()=>{
 const x=await recoveryWorkspaceApp();try{
  const productId=x.plan.productId,shopId=x.plan.shopId,at=Date.now()-86400000;
  x.journal.putProductCheck(shopId,productId,{code,at,retryAt:Date.now()+3600000,productState:{shopId,productId,complete:true,observedAt:at,source:code==='OFF_SHELF'?'live-platform-product-management':'live-platform-product-recycle',kind:code==='OFF_SHELF'?'off-shelf':'recycled',...(code==='OFF_SHELF'?{status:'已下架'}:{})}});
  const before=x.journal.db.prepare('SELECT body FROM product_checks WHERE shop=? AND product=?').get(shopId,productId).body;
  const response=await x.post('dual-activity-care-policy',{shopId,enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true});assert.equal(response.status,200,await response.clone().text());
  assert.equal(x.journal.db.prepare('SELECT body FROM product_checks WHERE shop=? AND product=?').get(shopId,productId).body,before);
  for(const scope of ['confirm','automatic','history'])assert.equal((await x.get('recovery-workspace?scope='+scope)).total,0);
  assert.equal(recoveryRequests(x.journal,shopId).items.some(r=>r.productId===productId),false);assert.equal(x.state.submits,0);
 }finally{await x.close();}
});

test('a newer same-context precheck failure replaces the old price prompt and is visible',async()=>{
 const x=await recoveryWorkspaceApp();try{
  const message='目标20件，实际19件，当前完整规格核验未通过';x.journal.putProductCheck(x.plan.shopId,x.plan.productId,{code:'PRECHECK_MEMBERSHIP',message,contextKey:x.plan.historicalFingerprint,at:Date.now(),retryAt:Date.now()+60000});
  assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);
  const automatic=await x.get('recovery-workspace?scope=automatic');assert.equal(automatic.total,1);assert.ok(automatic.records[0].summary.includes(message));
  const detail=await x.get('price-reviews/item?productId='+x.plan.productId);assert.equal(detail.approvalAllowed,false);assert.ok(detail.comparison.every(s=>s.classification==='pending'&&s.reason.includes(message)));assert.equal(x.state.submits,0);
 }finally{await x.close();}
});

test('expired independent pair disappears from confirmation and cannot be used to approve',async()=>{
 const x=await recoveryWorkspaceApp({now:Date.now()-121000});try{
  assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);assert.equal((await x.get('recovery-workspace?scope=automatic')).total,1);
  const detail=await x.get('price-reviews/item?productId='+x.plan.productId);assert.equal(detail.approvalAllowed,false);assert.equal(detail.review,null);
  assert.equal(x.state.submits,0);
 }finally{await x.close();}
});
