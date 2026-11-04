import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCatalog} from '../src/catalog.mjs';
import {withCatalogAttention} from '../src/catalog-attention.mjs';
import {workspaceOwnership} from '../src/workspace-ownership.mjs';
import {Journal} from '../src/journal.mjs';
import {fingerprint,proveReadback} from '../src/policy.mjs';
import {eroDualProposalFixture} from './helpers/ero-dual-proposal-fixture.mjs';

const now=1793769000000,shopId='900001',productId='300001';
const baseline={shopId,productId,name:'合成待处理商品',campaignId:'400001',historyAt:now-900000,type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'合成规格',baseFen:10000,discount:60,saleFen:6000}]};
function catalog({complete=false,stale=false,tasks=[],checks=[],excluded=[]}={}){return buildCatalog({shopId,histories:[baseline],tasks,checks,excluded,now,inventory:{listing:{complete:true,observedAt:stale?now-600000:now-27000,campaigns:[]},activeComplete:complete,details:new Map()}});}
const check=(at=now-1000)=>({shopId,productId,code:'DUAL_REDUCTION_REQUIRED',message:'当前允许的活动需要降价',at});
const review=(at=now-1000)=>({id:'synthetic-pending-review',shopId,productId,status:'pending',createdAt:at,expiresAt:at+120000,rows:[{id:'500001',saleFen:5900}]});
function readback(at=now-1000){
 const plan={shopId,productId,name:baseline.name,type:baseline.type,rules:baseline.rules,skus:baseline.skus};
 const task={id:'synthetic-verified-task',shopId,title:'合成独立回读',plans:[plan],phase:'verified',submitAttempts:1,createdAt:at-1000,submittedAt:at-900,updatedAt:at};
 task.receipt=proveReadback(task.plans,{complete:true,shopId,title:task.title,type:plan.type,rules:plan.rules,status:'进行中',campaignId:'400002',observedAt:at,rows:plan.skus.map(s=>({...s,productId,saleSource:'observed'}))},{title:task.title,now:at});return task;
}
for(const stale of [false,true])test('real independent price facts stay in known waiting during '+(stale?'stale':'fresh incomplete')+' full-store reads',t=>{
 const journal=new Journal(':memory:');t.after(()=>journal.close());const f=eroDualProposalFixture(journal,{now}),reviews=journal.priceReviews(f.plan.shopId),dualDecisions=new Map([[f.plan.productId,f.decision]]);
 const raw=buildCatalog({shopId:f.plan.shopId,histories:journal.histories(f.plan.shopId),now,inventory:{listing:{complete:true,observedAt:now-(stale?600000:27000),campaigns:[]},activeComplete:false,details:new Map()}});
 const ownership=workspaceOwnership({shopId:f.plan.shopId,products:raw.products,reviews,tasks:[],dualEnabled:true,dualDecisions,now}),before=fingerprint(raw),target=fingerprint(journal.priceTarget(f.plan.shopId,f.plan.productId));
 const result=withCatalogAttention({shopId:f.plan.shopId,catalog:raw,ownership,reviews,dualDecisions,now});
 assert.equal(raw.products.find(p=>p.productId===f.plan.productId).state,'unconfirmed');assert.equal(result.stale,stale);assert.equal(result.complete,false);assert.equal(result.counts.missingProducts,0);assert.equal(result.attention.waitingCount,1);assert.deepEqual(result.attention.waitingProductIds,[f.plan.productId]);
 const p=result.products.find(p=>p.productId===f.plan.productId);assert.equal(p.state,'unconfirmed');assert.equal(p.displayAttention.kind,'price-confirmation');assert.equal(p.current.length,0);assert.equal(result.counts.observedCurrentProducts,0);
 assert.equal(fingerprint(raw),before);assert.equal(fingerprint(journal.priceTarget(f.plan.shopId,f.plan.productId)),target);
});
test('expired suggestions retain only a waiting item and price-update label, without carrying any proposed amounts',()=>{
 const raw=catalog({stale:true}),r=review(now-121000),result=withCatalogAttention({shopId,catalog:raw,reviews:[r],now});
 assert.equal(result.attention.waitingCount,1);assert.equal(result.products[0].displayAttention.kind,'price-updating');assert.match(result.products[0].displayAttention.label,/更新/);assert.equal('rows' in result.products[0].displayAttention,false);assert.equal(JSON.stringify(result.attention).includes('5900'),false);assert.equal(JSON.stringify(result.products[0].displayAttention).includes('5900'),false);
 assert.equal(raw.products[0].state,'unconfirmed');assert.equal(result.products[0].state,'unconfirmed');
});
for(const source of ['ownership','check','request','task','missing'])test('known waiting includes '+source+' without requiring a complete catalog',()=>{
 const raw=catalog({complete:source==='missing'}),args={shopId,catalog:raw,now};
 if(source==='ownership')args.ownership={byProduct:new Map([[productId,{owner:'blockers',productId}]])};
 if(source==='check')args.checks=[check()];
 if(source==='request')args.requests=[{productId,requestedAt:now-1000,state:'deferred'}];
 if(source==='task')args.tasks=[{id:'synthetic-unknown',shopId,phase:'unknown',plans:[{...baseline}],updatedAt:now-1000}];
 const result=withCatalogAttention(args);assert.deepEqual(result.attention.waitingProductIds,[productId]);assert.equal(result.products[0].state,raw.products[0].state);assert.deepEqual(result.counts,raw.counts);
});
test('a strict newer receipt removes old checks, reviews and queued work without claiming a currently active activity',()=>{
 const task=readback(now-1000),oldCheck={...check(now-20000),code:'PRICE_REVIEW_REQUIRED'},raw=catalog({tasks:[task],checks:[oldCheck]}),r=review(now-30000),args={shopId,catalog:raw,tasks:[task],checks:[oldCheck],reviews:[r],requests:[{productId,requestedAt:now-15000,updatedAt:now-500,state:'deferred'}],ownership:{byProduct:new Map([[productId,{owner:'prices',productId}]])},now};
 const before=fingerprint({raw,task,r}),result=withCatalogAttention(args),p=result.products[0];
 assert.equal(result.attention.waitingCount,0);assert.deepEqual(result.attention.readbackProductIds,[productId]);assert.equal(p.displayAttention.kind,'readback');assert.equal(p.displayAttention.label,'已回读，目录更新中');assert.equal(p.state,'unconfirmed');assert.equal(p.current.length,0);assert.equal(result.counts.observedCurrentProducts,0);assert.ok(p.recoveryFailure,'raw diagnostic remains available');
 assert.equal(fingerprint({raw,task,r}),before);assert.equal(withCatalogAttention({...args,now:now+2000}).revision,result.revision,'unchanged facts do not repaint on each poll');
});
test('ordinary read timeouts after a valid receipt do not revive an old recovery item',()=>{
 const task=readback(now-1000),c={...check(now-500),code:'UI_READ_TIMEOUT',message:'平台读取超时'},raw=catalog({tasks:[task],checks:[c]}),result=withCatalogAttention({shopId,catalog:raw,tasks:[task],checks:[c],now});
 assert.equal(result.attention.waitingCount,0);assert.equal(result.products[0].displayAttention.kind,'readback');
});
for(const source of ['unresolved-task','new-request','new-review','new-loss-check','new-removed-member','later-complete-absence'])test('a verified receipt never hides later known work: '+source,()=>{
 const task=readback(now-20000),raw=catalog({tasks:[task],complete:source==='later-complete-absence'}),args={shopId,catalog:raw,tasks:[task],now};
 if(source==='unresolved-task')args.tasks.push({id:'synthetic-later-unknown',shopId,phase:'unknown',plans:[{...baseline}],updatedAt:now-1000});
 if(source==='new-request')args.requests=[{productId,requestedAt:now-1000,state:'pending'}];
 if(source==='new-review')args.reviews=[review(now-1000)];
 if(source==='new-loss-check')args.checks=[{...check(now-1000),lossKey:'synthetic-new-loss'}];
 if(source==='new-removed-member')raw.products[0].removed=[{campaignId:'400003',observedAt:now-1000}];
 if(source==='later-complete-absence'){raw.listingObservedAt=now-1000;raw.observedAt=now-1000;}
 const result=withCatalogAttention(args);assert.equal(result.attention.waitingCount,1);assert.equal(result.attention.readbackProductIds.length,0);if(source==='unresolved-task')assert.equal(result.products[0].displayAttention.kind,'verification');
});
for(const mutation of ['no-proof','wrong-count','future-receipt','wrong-shop'])test('an invalid readback cannot suppress waiting work: '+mutation,()=>{
 const task=readback(now-1000);if(mutation==='no-proof')delete task.receipt.evidenceFingerprint;if(mutation==='wrong-count')task.receipt.skuCount++;if(mutation==='future-receipt')task.receipt.verifiedAt=now+60000;if(mutation==='wrong-shop')task.shopId='900002';
 const raw=catalog(),result=withCatalogAttention({shopId,catalog:raw,tasks:[task],checks:[check(now-2000)],now});assert.equal(result.attention.waitingCount,1);assert.equal(result.attention.readbackProductIds.length,0);
});
test('a historical task updated recently never masquerades as a recently verified receipt',()=>{
 const task=readback(now-600000);task.updatedAt=now-100;const raw=catalog(),result=withCatalogAttention({shopId,catalog:raw,tasks:[task],checks:[{...check(now-1000),lossKey:'synthetic-later-loss'}],now});
 assert.equal(result.attention.waitingCount,1);assert.equal(result.attention.readbackProductIds.length,0);
});
test('hidden, excluded and other-shop ledgers cannot create an attention item',()=>{
 for(const mode of ['hidden','excluded','other-shop','other-catalog']){
  const raw=catalog({excluded:mode==='excluded'?[productId]:[]}),args={shopId,catalog:raw,checks:[check()],now};
  if(mode==='hidden')args.hiddenProductIds=[productId];if(mode==='other-shop')args.checks[0].shopId='900002';if(mode==='other-catalog')args.shopId='900002';
  const result=withCatalogAttention(args);assert.equal(result.attention.waitingCount,0);assert.equal(result.products[0].displayAttention,undefined);
 }
});
test('fresh positive product state suppresses old recovery work while an unresolved task still remains visible',()=>{
 const raw=catalog();raw.products[0].state='active';raw.products[0].current=[{campaignId:'400002',observedAt:now-500,skus:baseline.skus}];
 assert.equal(withCatalogAttention({shopId,catalog:raw,checks:[check()],now}).attention.waitingCount,0);
 const pending={id:'synthetic-unknown',shopId,phase:'unknown',plans:[{...baseline}],updatedAt:now-1000};assert.equal(withCatalogAttention({shopId,catalog:raw,tasks:[pending],now}).attention.waitingCount,1);
});
test('products without any known unfinished ledger remain unconfirmed instead of being invented as missing',()=>{
 const raw=catalog({stale:true}),result=withCatalogAttention({shopId,catalog:raw,now});assert.equal(result.attention.waitingCount,0);assert.equal(result.products[0].state,'unconfirmed');assert.equal(result.products[0].displayAttention,undefined);
});
test('later saved positive product observations cover ancient blocked work even after full-store freshness expires',()=>{
 for(const surface of ['current','scheduled','lastObserved']){
  const task={id:'synthetic-old-blocked',shopId,phase:'blocked',plans:[{...baseline}],updatedAt:now-500000,lossEvidence:{complete:true,observedAt:now-500000,lossKey:'synthetic-old-loss'}},c={...check(now-500000),code:'PRICE_REVIEW_REQUIRED'},r=review(now-500000),raw=catalog({stale:true,tasks:[task],checks:[c]});
  raw.products[0][surface]=[{campaignId:'400002',observedAt:now-360000,skus:structuredClone(baseline.skus)}];
  const before=fingerprint(raw),result=withCatalogAttention({shopId,catalog:raw,tasks:[task],checks:[c],reviews:[r],now}),p=result.products[0];
  assert.equal(result.attention.waitingCount,0);assert.equal(result.attention.readbackProductIds.length,0);assert.equal(p.displayAttention.kind,'observed');assert.equal(p.displayAttention.label,'活动信息更新中');assert.equal(p.state,'unconfirmed');assert.equal(result.counts.observedCurrentProducts,0);assert.equal(fingerprint(raw),before);assert.ok(p.recoveryFailure);
 }
});
test('new loss, price facts, requests and unknown tasks remain waiting after a saved positive observation',()=>{
 for(const source of ['loss','review','request','unknown']){
  const old={id:'synthetic-old-blocked',shopId,phase:'blocked',plans:[{...baseline}],updatedAt:now-500000},raw=catalog({stale:true,tasks:[old]});raw.products[0].lastObserved=[{campaignId:'400002',observedAt:now-360000,skus:structuredClone(baseline.skus)}];
  const args={shopId,catalog:raw,tasks:[old],now};
  if(source==='loss')args.checks=[{...check(now-1000),lossKey:'synthetic-new-loss'}];
  if(source==='review')args.reviews=[review(now-1000)];
  if(source==='request')args.requests=[{productId,requestedAt:now-1000,state:'pending'}];
  if(source==='unknown')args.tasks.push({id:'synthetic-unknown-after-positive',shopId,phase:'unknown',plans:[{...baseline}],updatedAt:now-500000});
  const result=withCatalogAttention(args);assert.equal(result.attention.waitingCount,1,source);assert.notEqual(result.products[0].displayAttention.kind,'observed');assert.equal(result.products[0].state,'unconfirmed');
 }
});
