import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {createApp} from '../src/server.mjs';
import {fingerprint,proveDraft} from '../src/policy.mjs';
import {applyPriceTarget} from '../src/price-review.mjs';
import {applyCampaignPolicy} from '../src/campaign-policy.mjs';
import {makeDualActivityDecision,getDualActivityDecision,dualPriceApprovalReady,validDualActivityApproval} from '../src/dual-activity-recovery.mjs';
import {unresolvedDualFixture} from './helpers/unresolved-dual-fixture.mjs';
import {dualDraftObservation} from './helpers/dual-activity-fixture.mjs';

function fixture(t,options={}){const journal=new Journal(':memory:');t.after(()=>journal.close());return unresolvedDualFixture(journal,{preservedLimitedSource:true,limitedCapFen:5900,...options});}
test('a genuinely archived limited loss keeps its quota and exposes only the complete limited lowering',t=>{
 const f=fixture(t),d=f.decision;
 assert.equal(f.baseline.type,'限时抢购');assert.equal(f.task.plans[0].type,'限时抢购');assert.equal(f.task.riskAttempts,1);
 assert.deepEqual(f.archive.closure.perProduct[0].allowedTypes,['限量抢购']);assert.equal(f.archive.closure.perProduct[0].preserveLimitedQuota,true);
 assert.equal(d.valid,true);assert.equal(dualPriceApprovalReady(d),true);assert.equal(d.selectedType,null);
 const [timed,limited]=d.schemes;assert.equal(timed.classification,'unavailable');assert.equal(timed.scopeExcluded,true);assert.equal(timed.scopeExclusion,'preserve-limited-quota');assert.match(timed.reason,/不能改走限时/);assert.equal(timed.review,null);assert.equal(timed.candidate,undefined);
 assert.equal(limited.classification,'reduction-required');assert.equal(limited.review.activityLimit,1000);assert.ok(limited.candidate.rows.some(r=>r.saleFen<r.previousFen));
 assert.equal(f.journal.priceTarget(f.shopId,f.productId),null);
 const review=f.journal.priceReview(d.reviewIds['限量抢购']),approved=f.journal.decidePriceReview(f.shopId,review.id,review.key,'approve',{acceptPriceAndRisk:true,confirmedSkuIds:review.rows.map(r=>r.id),historicalFingerprint:review.historicalFingerprint},f.now);
 assert.equal(approved.type,'限量抢购');assert.equal(approved.activityLimit,1000);assert.equal(approved.dualManualSource.scopeRestriction.key,f.archive.closure.key);
 const execution=applyCampaignPolicy(applyPriceTarget(f.plan,approved),f.journal);f.journal.assertPricePlans(f.shopId,[execution]);
 const next=f.journal.enqueue(f.shopId,[execution],{complete:true,observedAt:f.now+1,lossKey:'synthetic-limited-current-loss',unresolvedRecoveryClosureId:f.archive.id},f.now+1);
 f.journal.transition(next.id,'queued','prepared',{},f.now+1);f.journal.beginSubmit(next.id,proveDraft(next,dualDraftObservation(next,{now:f.now+2}),f.now+2),f.now+2);
 assert.equal(f.journal.get(next.id).submitAttempts,1);assert.equal(f.journal.get(f.task.id).submitAttempts,1);assert.equal(f.journal.get(f.task.id).riskAttempts,1);assert.equal(f.journal.get(f.task.id).phase,'blocked');
});
test('a legal non-reducing limited candidate stays automatic and cannot borrow the excluded timed candidate',t=>{
 const f=fixture(t,{limitedCapFen:null,timedCapFen:null});assert.equal(f.decision.selectedType,'限量抢购');assert.equal(f.decision.approvalAllowed,false);assert.equal(dualPriceApprovalReady(f.decision),false);
 const target=f.journal.approveDualActivityDecision(f.shopId,f.productId,f.decision.pairKey,f.now);
 assert.equal(target.type,'限量抢购');assert.equal(target.activityLimit,1000);assert.equal(validDualActivityApproval(f.journal,target),true);assert.ok(target.rows.every(r=>r.saleFen===r.previousFen));
 assert.equal(f.journal.get(f.task.id).submitAttempts,1);assert.equal(f.journal.list(f.shopId).filter(t=>t.phase==='verified').length,0);
});
test('a restricted timed scheme never substitutes for missing limited evidence',t=>{
 const f=fixture(t,{recordDecision:false,timedCapFen:null}),made=makeDualActivityDecision({plan:f.plan,probes:f.probes.filter(p=>p.type==='限时抢购'),scopeRestriction:f.archive.closure,journal:f.journal,now:f.now});
 assert.equal(made.selectedType,null);assert.equal(made.approvalAllowed,false);assert.equal(made.schemes[0].scopeExcluded,true);assert.equal(made.schemes[1].classification,'pending');
});
test('JSON payloads and an unavailable real archive cannot manufacture the limited-scope approval brand',t=>{
 const f=fixture(t),copy=JSON.parse(JSON.stringify(f.decision));assert.equal(copy.approvalAllowed,true);assert.equal(dualPriceApprovalReady(copy),false);
 assert.throws(()=>makeDualActivityDecision({plan:f.plan,probes:f.probes,scopeRestriction:f.archive.closure,now:f.now}),{code:'DUAL_SCOPE_INVALID'});
 f.journal.unresolvedRecovery=()=>null;const changed=getDualActivityDecision(f.journal,f.shopId,f.productId,f.now);assert.equal(changed.valid,false);assert.equal(changed.approvalAllowed,false);
});
for(const mode of ['missing-bound','duplicate-bound','sold-out','wrong-source','wrong-source-kind','wrong-source-type','wrong-history','missing-proof','too-large','excess-quota'])test('limited scope rejects unsafe persisted quantity binding: '+mode,t=>{
 const f=fixture(t,{recordDecision:false}),scope=structuredClone(f.archive.closure),bound=scope.quantityBounds[0],source=scope.sourceReferences.find(s=>s.kind==='recorded-loss');
 if(mode==='missing-bound')scope.quantityBounds=[];
 if(mode==='duplicate-bound')scope.quantityBounds.push(structuredClone(bound));
 if(mode==='sold-out')bound.soldOut=true;
 if(mode==='wrong-source')bound.sourceCampaignId='499999';
 if(mode==='wrong-source-kind')source.kind='unverified-source';
 if(mode==='wrong-source-type')source.type='限时抢购';
 if(mode==='wrong-history')source.historicalFingerprint='a'.repeat(64);
 if(mode==='missing-proof')delete bound.evidenceFingerprint;
 if(mode==='too-large')bound.maxActivityLimit=bound.sourceActivityLimit=1001;
 if(mode==='excess-quota')bound.maxActivityLimit=1001;
 scope.key=fingerprint({...scope,key:undefined});
 // Model corrupted persisted material as well as the caller's copy: validity
 // must depend on the archived source/bound, not only matching JSON hashes.
 const read=f.journal.unresolvedRecovery.bind(f.journal);f.journal.unresolvedRecovery=id=>({...read(id),closure:scope});
 assert.throws(()=>makeDualActivityDecision({plan:f.plan,probes:f.probes,scopeRestriction:scope,journal:f.journal,now:f.now}),{code:'DUAL_SCOPE_INVALID'});
 assert.equal(f.journal.priceTarget(f.shopId,f.productId),null);assert.equal(f.journal.get(f.task.id).submitAttempts,1);
});
test('a fresh limited draft above the genuinely archived remaining quota cannot yield any price candidate',t=>{
 const f=fixture(t,{recordDecision:false}),scope=structuredClone(f.archive.closure);scope.quantityBounds[0].maxActivityLimit=999;scope.key=fingerprint({...scope,key:undefined});
 const read=f.journal.unresolvedRecovery.bind(f.journal);f.journal.unresolvedRecovery=id=>({...read(id),closure:scope});
 const made=makeDualActivityDecision({plan:f.plan,probes:f.probes,scopeRestriction:scope,journal:f.journal,now:f.now});
 assert.equal(made.selectedType,null);assert.equal(made.approvalAllowed,false);assert.equal(made.schemes[1].classification,'pending');assert.equal(made.schemes[1].code,'UNRESOLVED_QUANTITY');assert.equal(made.schemes[1].candidate,undefined);
});

async function scopedApp(options={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-preserved-limited-')),journal=new Journal(':memory:'),f=unresolvedDualFixture(journal,{preservedLimitedSource:true,limitedCapFen:5900,...options}),platform={probe:async()=>({shopId:f.shopId,name:'合成限量恢复验收'}),progress:{stage:'尚未连接'}};
 const service=new GuardianService({journal,platform,policy:f.policy,immediate:false}),app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
 const get=async path=>{const r=await fetch(app.url+'/api/'+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
 await fetch(app.url+'/api/finish-login',{method:'POST',headers,body:'{}'});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
 return{...f,get,close:async()=>{await app.close();await rm(runtime,{recursive:true,force:true});}};
}
test('the real workspace API offers one limited confirmation and no usable timed option without changing the price target',async()=>{
 const x=await scopedApp();try{
  const list=await x.get('recovery-workspace?scope=confirm');assert.equal(list.total,1);assert.equal(list.records[0].approvalAllowed,true);assert.match(list.records[0].summary,/保留原限量额度/);assert.equal(list.records[0].schemes[0].scopeExclusion,'preserve-limited-quota');assert.equal((await x.get('recovery-workspace?scope=automatic')).total,0);
  const item=await x.get('price-reviews/item?productId='+x.productId);assert.equal(item.approvalAllowed,true);assert.equal(item.review.type,'限量抢购');assert.ok(item.review.options.some(o=>o.available&&o.activityType==='限量抢购'));assert.equal(item.review.options.some(o=>o.available&&o.activityType==='限时抢购'),false);
  assert.equal(x.journal.priceTarget(x.shopId,x.productId),null);assert.equal(x.journal.get(x.task.id).submitAttempts,1);assert.equal(x.journal.get(x.task.id).riskAttempts,1);
 }finally{await x.close();}
});
test('the real workspace keeps a non-reducing limited scheme in the background without asking for a price confirmation',async()=>{
 const x=await scopedApp({limitedCapFen:null});try{
  assert.equal((await x.get('recovery-workspace?scope=confirm')).total,0);const list=await x.get('recovery-workspace?scope=automatic');assert.equal(list.total,1);assert.equal(list.records[0].approvalAllowed,false);assert.equal(list.records[0].schemes[1].classification,'non-reducing');assert.equal(list.records[0].schemes[0].scopeExclusion,'preserve-limited-quota');assert.equal(x.journal.priceTarget(x.shopId,x.productId),null);
 }finally{await x.close();}
});
