import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {fingerprint,planOriginalRestore,proveDraft} from '../src/policy.mjs';
import {parsePriceConstraint,makePriceReviews,applyPriceTarget} from '../src/price-review.mjs';
import {fixedNow as now,priceFixture} from './helpers/price-review-fixture.mjs';

test('numeric limits distinguish strict bounds, day counts, floors and coupon risk',()=>{
 assert.equal(parsePriceConstraint('活动价不得高于近15天最低价（68元）').maxFen,6800);
 assert.equal(parsePriceConstraint('单品活动价¥69.50，需≤¥68.00').maxFen,6800);
 assert.equal(parsePriceConstraint('活动价必须低于68元').maxFen,6799);
 assert.equal(parsePriceConstraint('活动价必须高于68元').minFen,6801);
 for(const text of ['活动价不能高于近15天最低价','预估最低到手价15元，存在低价风险','请降至15折','活动价不能高于68元，也不能低于未知金额'])assert.equal(parsePriceConstraint(text),null);
});

function record(j,f){const r=j.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);j.transition(f.task.id,'queued','blocked',{retryAfter:now+900000},now);return r;}
function consent(r){return {confirmedSkuIds:r.rows.map(s=>s.id),acceptPriceAndRisk:true,historicalFingerprint:r.historicalFingerprint};}
test('proposal enumerates the closest lower step without modifying history or granting execution',()=>{
 const j=new Journal(':memory:');try{
  const f=priceFixture(j),before=fingerprint(f.baseline),r=record(j,f);
  assert.deepEqual(r.rows.map(s=>[s.previousFen,s.discount,s.saleFen]),[[6950,48,6672],[6000,60,6000]]);
  assert.equal(j.priceTarget(f.plan.shopId,f.plan.productId),null);assert.deepEqual(applyPriceTarget(f.plan,r),f.plan);
  assert.equal(fingerprint(f.baseline),before);assert.equal(j.histories(f.plan.shopId)[0].skus[0].discount,50);
 }finally{j.close();}
});
for(const mutation of ['diagnostic','expired','unmapped-warning','changed-price','duplicate','unknown-risk','conflicting-bounds'])test('proposal rejects insufficient direct evidence: '+mutation,()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j);
  if(mutation==='diagnostic')f.probe.source='local-diagnostic-export';
  if(mutation==='expired')f.probe.observedAt=now-31000;
  if(mutation==='unmapped-warning')f.probe.warnings.push('其他未解析的价格提示');
  if(mutation==='changed-price')f.probe.rows[0].discount=48;
  if(mutation==='duplicate')f.probe.rows.push({...f.probe.rows[0]});
  if(mutation==='unknown-risk')f.probe.rows[0].errors=f.probe.warnings=['存在低价风险，请提高活动价格'];
  if(mutation==='conflicting-bounds'){f.probe.rows[0].errors.push('活动价不得低于69元');f.probe.warnings=[...f.probe.rows[0].errors];}
  assert.throws(()=>makePriceReviews(f.task,f.probe,now));assert.equal(j.priceReviews(f.plan.shopId).length,0);
 }finally{j.close();}
});
for(const mutation of ['no-consent','missing-sku','duplicate-sku','wrong-shop','changed-key','expired','changed-history','unknown-submit'])test('price approval rejects '+mutation,()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j),r=record(j,f),args=consent(r);let shop=r.shopId,key=r.key,time=now+1;
  if(mutation==='no-consent')args.acceptPriceAndRisk=false;
  if(mutation==='missing-sku')args.confirmedSkuIds.pop();
  if(mutation==='duplicate-sku')args.confirmedSkuIds.push(args.confirmedSkuIds[0]);
  if(mutation==='wrong-shop')shop='900002';if(mutation==='changed-key')key='changed';if(mutation==='expired')time=r.expiresAt;
  if(mutation==='changed-history')args.historicalFingerprint='changed';
  if(mutation==='unknown-submit'){
   const t=j.enqueue(shop,[f.plan],{complete:true,lossKey:'new-unknown',observedAt:now},now);j.transition(t.id,'queued','prepared',{},now);
   j.beginSubmit(t.id,proveDraft(t,{...f.probe,title:t.title,warnings:[],rows:f.probe.rows.map(row=>({...row,errors:[]}))},now),now);
   j.transition(t.id,'submitting','unknown',{},now);
  }
  assert.throws(()=>j.decidePriceReview(shop,r.id,key,'approve',args,time));assert.equal(j.priceTarget(r.shopId,r.productId),null);
 }finally{j.close();}
});
test('exact confirmed target survives restart while full history and missing SKU policy remain separate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'guardian-price-journal-')),path=join(dir,'test.sqlite');let j=new Journal(path);
 try{const f=priceFixture(j),r=record(j,f);j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+1);j.close();j=new Journal(path);
  const target=j.priceTarget(r.shopId,r.productId),plan=applyPriceTarget(f.plan,target);j.assertPricePlans(r.shopId,[plan]);
  assert.equal(plan.originalRiskAllowed,false);assert.equal(plan.approvedRiskAllowed,true);assert.equal(plan.skus[0].discount,48);
  assert.equal(j.histories(r.shopId)[0].skus[0].discount,50);
  const missing=structuredClone(f.current);missing.skus.pop();const subset=applyPriceTarget(planOriginalRestore(f.baseline,missing,f.policy,now),target);
  assert.equal(subset.skus.length,1);assert.equal(subset.skus[0].discount,48);assert.equal(j.histories(r.shopId)[0].skus.length,2);
  const tampered=structuredClone(plan);tampered.skus[0].discount=47;tampered.skus[0].saleFen=6533;assert.throws(()=>j.assertPricePlans(r.shopId,[tampered]));
  const newer={...f.baseline,campaignId:'4000000000000000099'};assert.equal(applyPriceTarget(planOriginalRestore(newer,f.current,f.policy,now),target).skus[0].discount,50);
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});
test('excluded product cannot be approved through the service even with an existing proposal',()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j),r=record(j,f);f.policy.excludedProductIds.push(r.productId);
  const service=new GuardianService({journal:j,platform:{},policy:f.policy,now:()=>now});
  assert.throws(()=>service.decidePriceReview({reviewId:r.id,key:r.key,decision:'approve',...consent(r)}),{code:'PRICE_REVIEW_CHANGED'});
 }finally{j.close();}
});

test('a freshly verified active activity supersedes an unapproved price proposal',async()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j),r=record(j,f);
  const platform={discover:async()=>({baselines:[],activeComplete:true}),loss:async()=>({complete:true,active:true,observedAt:now})};
  const service=new GuardianService({journal:j,platform,policy:f.policy,now:()=>now+1});await service.tick();
  assert.equal(j.priceReview(r.id).status,'superseded');assert.equal(j.priceTarget(r.shopId,r.productId),null);
  assert.throws(()=>j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+2));
 }finally{j.close();}
});

test('a new direct price proposal replaces pending older bounds and stale approved plans cannot execute',()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j),first=record(j,f);
  const t=j.enqueue(f.plan.shopId,[f.plan],{complete:true,lossKey:'new-bounds',observedAt:now},now);
  const probe={...f.probe,title:t.title,warnings:['活动价不得高于65元'],rows:f.probe.rows.map((r,i)=>({...r,errors:i?[]:['活动价不得高于65元']}))};
  const next=j.recordPriceReview(makePriceReviews(t,probe,now)[0],now);j.transition(t.id,'queued','blocked',{},now);
  assert.equal(j.priceReview(first.id).status,'superseded');assert.equal(next.rows[0].discount,46);
  j.decidePriceReview(next.shopId,next.id,next.key,'approve',consent(next),now+1);const approvedPlan=applyPriceTarget(f.plan,j.priceTarget(next.shopId,next.productId));
  const newer=j.enqueue(next.shopId,[approvedPlan],{complete:true,lossKey:'even-lower',observedAt:now},now);
  const updated={...probe,title:newer.title,rows:approvedPlan.skus.map((r,i)=>({...r,productId:approvedPlan.productId,errors:i?[]:['活动价不得高于60元']})),warnings:['活动价不得高于60元']};
  const last=j.recordPriceReview(makePriceReviews(newer,updated,now)[0],now);j.transition(newer.id,'queued','blocked',{},now);
  j.decidePriceReview(last.shopId,last.id,last.key,'approve',consent(last),now+2);
  assert.throws(()=>j.assertPricePlans(last.shopId,[approvedPlan]),{code:'PRICE_APPROVAL_CHANGED'});
 }finally{j.close();}
});

test('missing the lowered SKU keeps the approval chain for a later proposal on another SKU',()=>{
 const j=new Journal(':memory:');try{const f=priceFixture(j),r=record(j,f);j.decidePriceReview(r.shopId,r.id,r.key,'approve',consent(r),now+1);
  const current={...f.current,skus:[f.current.skus[1]]},original=planOriginalRestore(f.baseline,current,f.policy,now);
  const plan=applyPriceTarget(original,j.priceTarget(r.shopId,r.productId));
  assert.equal(plan.priceApprovalId,r.id);assert.equal(plan.skus[0].discount,60);
  const task=j.enqueue(r.shopId,[plan],{complete:true,lossKey:'lowered-sku-missing',observedAt:now},now);
  const probe={...f.probe,title:task.title,rows:plan.skus.map(s=>({...s,productId:plan.productId,errors:['活动价不得高于58元']})),warnings:['活动价不得高于58元']};
  const next=j.recordPriceReview(makePriceReviews(task,probe,now)[0],now);j.transition(task.id,'queued','blocked',{},now);
  j.decidePriceReview(next.shopId,next.id,next.key,'approve',consent(next),now+2);
  assert.equal(j.priceTarget(r.shopId,r.productId).rows[0].discount,58);assert.equal(j.histories(r.shopId)[0].skus.length,2);
 }finally{j.close();}
});
