import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {priceMode,priceModeFields,expectedSaleFen,validateHistorical,planOriginalRestore,proveDraft,proveReadback,proveOriginalRisk,fingerprint,draftMaterial,restorationGroupKey,fixedActivityMaxFen} from '../src/policy.mjs';
import {makePriceReviews,applyPriceTarget} from '../src/price-review.mjs';
import {priceOptions} from '../src/price-options.mjs';
import {selectClosestPriceStep,parsePriceConstraint} from '../src/price-constraints.mjs';
import {selectRatioPrices} from '../src/ratio-prices.mjs';
import {manualPriceOption} from '../src/manual-price-option.mjs';
import {isAutomaticPriceIncrease} from '../src/price-increase-policy.mjs';
import {setDualActivityCarePolicy,activeDualActivityCareGrant,dualProbePlan,makeDualActivityDecision,getDualActivityDecision,dualPriceProposalReady} from '../src/dual-activity-recovery.mjs';
import {createPriceApprovalIntent,validateFreshPriceIntent} from '../src/price-approval-intent.mjs';
import {GuardianService} from '../src/service.mjs';

const at=1794039000000,shopId='900001',productId='3000000000000000765';
function fixed(t,{dual=false,limited=false}={}){
 const j=new Journal(':memory:');t.after(()=>j.close());
 const baseline={priceMode:'fixed',source:'verified-platform-history',complete:true,shopId,productId,name:'固定金额测试商品',campaignId:'4000000000000000765',type:limited?'限量抢购':'限时抢购',
  ...(limited?{durationMs:7*86400000,activityLimit:1000}:{}),rules:{noLimit:!limited,noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(limited?{autoRenew:true}:{})},
  skus:[{id:'5000000000000000765',name:'规格甲',baseFen:12345,discount:null,saleFen:4999,saleSource:'observed'},{id:'5000000000000000766',name:'规格乙',baseFen:20000,discount:null,saleFen:8743,saleSource:'observed'}]};
 const policy={shopId,excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true},current={shopId,productId,complete:true,observedAt:at,skus:structuredClone(baseline.skus)};
 j.remember(baseline,at);const accounts=new AccountRegistry(j);accounts.register({shopId},'signin-fixed-core-fixture');accounts.authorizeOriginal(shopId);
 if(dual)setDualActivityCarePolicy(j,shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},at);
 const plan=planOriginalRestore(baseline,current,policy,at);
 return {j,baseline,current,policy,plan};
}
function observation(task,{now=at,cap=null,errorsById={}}={}){
 const p=task.plans[0],rows=p.skus.map(s=>({...s,productId:p.productId,errors:[...(errorsById[s.id]||[]),...(cap!=null&&s.saleFen>cap?['单品活动价￥'+s.saleFen/100+'，需≤￥'+cap/100]:[])]}));
 return {priceMode:'fixed',source:'live-platform-draft',kind:'draft',shopId,title:task.title,complete:true,observedAt:now,type:p.type,rules:p.rules,startAt:now,endAt:now+(p.durationMs??48*3600000),...(p.type==='限量抢购'?{productLimits:[{productId,activityLimit:p.activityLimit}]}:{}),rows,warnings:[...new Set(rows.flatMap(s=>s.errors))],dialogs:[]};
}
function dual(f,{now=at,caps={},errors={},failure=null}={}){
 const grant=activeDualActivityCareGrant(f.j,shopId,now),{fingerprint:old,...body}=f.plan,plan={...body,observedAt:now};plan.fingerprint=fingerprint(plan);
 const probes=['限时抢购','限量抢购'].map(type=>{
  const task={id:'fixed-probe-'+type,title:'fixed-probe-'+type,shopId,phase:'queued',plans:[dualProbePlan(plan,type,grant.choices)],submitAttempts:0,riskAttempts:0,dualProbe:{grantId:grant.id,choices:structuredClone(grant.choices),plan:structuredClone(plan)}};
  return {type,task,...(type===failure?{error:{code:'FIXED_ACTIVITY_UNAVAILABLE',message:'未取得本活动官方一口价模板'}}:{observation:observation(task,{now,cap:caps[type],errorsById:errors})})};
 });
 const made=makeDualActivityDecision({plan,probes,now,journal:f.j}),saved=f.j.recordDualActivityDecision(made,now);
 return {plan,probes,decision:saved};
}
function approvalInputs(f,next=dual(f,{caps:{'限时抢购':4321,'限量抢购':4209}})){
 const decision=getDualActivityDecision(f.j,shopId,productId,next.decision.createdAt),review=f.j.priceReview(decision.reviewIds['限时抢购']),option=priceOptions(review).find(o=>o.id==='original');
 const args={shopId,reviewId:review.id,key:review.key,decision:'approve',dualPairKey:decision.pairKey,optionId:option.id,optionKey:option.key,acceptPriceAndRisk:true,acceptBlockedPriceChange:true,confirmedSkuIds:option.rows.map(r=>r.id)};
 return {...next,decision,review,option,args,now:next.decision.createdAt};
}
function serviceFixture(t,{cap=null,dropReadback=false}={}){
 const f=fixed(t,{dual:true}),state={submits:0,active:false,readbacks:0,observations:new Map(),prepared:[]};
 const platform={discover:async()=>({baselines:[f.baseline],activeComplete:true}),loss:async()=>({complete:true,observedAt:at,active:state.active,campaignId:state.active?'4000000000000000766':null,lossKey:'fixed-service-loss'}),precheck:async()=>structuredClone(f.current),
  priceCheck:async task=>observation(task,{cap}),prepare:async task=>{state.prepared.push(structuredClone(task.plans));const o=observation(task,{cap});if(o.warnings.length)throw Object.assign(Error('fixed cap'),{code:'PRICE_REVIEW_REQUIRED',detail:{priceProbe:o}});return {observation:o};},
  submit:async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,at));state.submits++;state.active=true;state.observations.set(task.title,{...draft.observation,rows:draft.observation.rows.map(s=>({...s,saleSource:'observed'})),status:'进行中',campaignId:'4000000000000000766'});},
  readback:async task=>{state.readbacks++;if(dropReadback){dropReadback=false;return null;}return state.observations.get(task.title)||null;},release:async()=>{}};
 const service=new GuardianService({journal:f.j,platform,policy:f.policy,now:()=>at});t.after(()=>service.stop());return {...f,state,platform,service};
}

test('fixed restoration preserves arbitrary exact fen, immutable history, and explicit mode',t=>{
 const f=fixed(t),hash=fingerprint(f.baseline);assert.equal(validateHistorical(f.baseline),f.baseline);
 assert.equal(f.plan.priceMode,'fixed');assert.deepEqual(f.plan.skus.map(s=>[s.discount,s.saleFen]),[[null,4999],[null,8743]]);assert.equal(fingerprint(f.baseline),hash);
 assert.equal(expectedSaleFen(f.plan.skus[0],f.plan),4999);assert.deepEqual(priceModeFields({}),{});assert.equal(priceMode({}),'discount');
 f.j.assertPricePlans(shopId,[f.plan]);
});
for(const [label,change] of [['fractional fen',s=>s.saleFen=4999.1],['zero',s=>s.saleFen=0],['above base',s=>s.saleFen=s.baseFen+1],['discount conversion',s=>s.discount=40],['omitted null discount',s=>delete s.discount]])test('fixed history rejects '+label,t=>{const f=fixed(t);change(f.baseline.skus[0]);assert.throws(()=>validateHistorical(f.baseline));});
test('unknown mode and mixed-mode task cannot fall through as discount',t=>{
 const f=fixed(t);assert.throws(()=>priceMode({priceMode:'guess'}),{code:'PRICE_MODE_UNKNOWN'});
 const other=structuredClone(f.plan);delete other.priceMode;other.productId='3000000000000000766';
 assert.throws(()=>f.j.enqueue(shopId,[f.plan,other],{complete:true,observedAt:at,lossKey:'mixed'},at),{code:'PRICE_MODE_CHANGED'});
 assert.notEqual(restorationGroupKey(f.plan),restorationGroupKey(other));
});
for(const [label,change,code] of [['base changed',f=>f.current.skus[0].baseFen++,'BASE_PRICE_CHANGED'],['shop changed',f=>f.current.shopId='900002','SHOP_MISMATCH'],['off shelf',f=>f.current.offShelf=true,'OFF_SHELF'],['active activity',f=>f.current.activeCampaign='400999','ALREADY_ACTIVE'],['stale complete evidence',f=>f.current.observedAt-=120001,'STALE_OR_INCOMPLETE']])test('fixed restores retain original guard: '+label,t=>{const f=fixed(t);change(f);assert.throws(()=>planOriginalRestore(f.baseline,f.current,f.policy,at),{code});});
test('fixed draft, risk and readback require exact mode and amounts',t=>{
 const f=fixed(t),task=f.j.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'fixed-draft'},at),o=observation(task);
 assert.ok(proveDraft(task,o,at));const bad=structuredClone(o);delete bad.priceMode;assert.throws(()=>proveDraft(task,bad,at),{code:'PRICE_MODE_CHANGED'});assert.notEqual(draftMaterial(o),draftMaterial(bad));
 bad.priceMode='fixed';bad.rows[0].saleFen--;assert.throws(()=>proveDraft(task,bad,at),{code:'DRAFT_PRICE'});
 f.j.transition(task.id,'queued','prepared',{},at);const submitted=f.j.beginSubmit(task.id,proveDraft(task,o,at),at);
 const risk={...o,dialogs:[`1个商品存在低价风险，请谨慎新建 预估最低到手价 ID：${productId} 仍要创建`]};assert.ok(proveOriginalRisk(submitted,risk,at));
 const altered=structuredClone(risk);altered.rows[1].saleFen--;assert.throws(()=>proveOriginalRisk(submitted,altered,at),{code:'DRAFT_PRICE'});
 const live={...o,rows:o.rows.map(r=>({...r,saleSource:'observed'})),status:'进行中',campaignId:'4000000000000000766'};assert.equal(proveReadback([f.plan],live,{title:task.title,now:at}).priceMode,'fixed');
 live.rows[0].saleSource='computed-from-verified-base-and-discount';assert.throws(()=>proveReadback([f.plan],live,{now:at}),{code:'READBACK_PRICE_SOURCE'});
});
test('fixed unapproved history cannot authorize a mutated fen or disguised discount',t=>{
 const f=fixed(t),p=structuredClone(f.plan);p.skus[0].saleFen--;assert.throws(()=>f.j.assertPricePlans(shopId,[p]),{code:'PRICE_APPROVAL_CHANGED'});p.skus[0].discount=40;assert.throws(()=>f.j.assertPricePlans(shopId,[p]));
});
test('a matching amount never permits an approval to drop its fixed-mode identity',t=>{
 const f=fixed(t),review={id:'fixed-target',key:'fixed-target-key',status:'approved',shopId,productId,historicalFingerprint:f.plan.historicalFingerprint,rows:f.plan.skus.map(s=>({...s,historicalDiscount:null}))};
 assert.throws(()=>applyPriceTarget(f.plan,review),{code:'PRICE_MODE_CHANGED'});
 review.priceMode='fixed';assert.deepEqual(applyPriceTarget(f.plan,review).skus.map(s=>s.saleFen),[4999,8743]);
});
test('fixed independent activity capability failure permits only the unchanged verified other activity',t=>{
 const f=fixed(t,{dual:true}),d=dual(f,{failure:'限量抢购'}).decision;
 assert.equal(d.selectedType,'限时抢购');assert.equal(d.approvalAllowed,false);assert.equal(d.schemes[1].classification,'pending');
 const blocked=dual(f,{caps:{'限时抢购':4321},failure:'限量抢购'}).decision;assert.equal(blocked.selectedType,null);assert.equal(blocked.approvalAllowed,false);assert.equal(dualPriceProposalReady(getDualActivityDecision(f.j,shopId,productId,at)),false);assert.equal(f.j.list(shopId).length,0);
});
test('fixed explicit caps produce cent-exact human proposals, never auto-reduction',t=>{
 const f=fixed(t),task=f.j.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'fixed-cap'},at),probe=observation(task,{cap:4321}),review=makePriceReviews(task,probe,at)[0];
 assert.equal(review.priceMode,'fixed');assert.deepEqual(review.rows.map(s=>s.saleFen),[4321,4321]);assert.equal(isAutomaticPriceIncrease(review),false);assert.equal(priceOptions(review).find(o=>o.id==='balanced').available,false);
 assert.equal(f.j.priceTarget(shopId,productId),null);
});
test('fixed observed short price constraint is parsed only as a complete exact statement',t=>{
 assert.equal(parsePriceConstraint('一口价金额≤42.17').maxFen,4217);assert.equal(parsePriceConstraint('一口价金额<42.17').maxFen,4216);
 assert.equal(parsePriceConstraint('一口价金额≥42.17').minFen,4217);assert.equal(parsePriceConstraint('一口价金额>42.17').minFen,4218);
 for(const text of ['一口价金额≤42.177','建议一口价金额≤42.17','一口价金额≤42.17且符合其他要求','一口价金额约42.17','一口价金额≤￥42.17'])assert.equal(parsePriceConstraint(text),null,text);
 const f=fixed(t),task=f.j.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'fixed-short-cap'},at),probe=observation(task,{errorsById:{'5000000000000000765':['一口价金额≤42.17']}}),review=makePriceReviews(task,probe,at)[0];
 assert.deepEqual(review.rows.map(r=>r.saleFen),[4217,8743]);assert.equal(isAutomaticPriceIncrease(review),false);assert.equal(f.j.priceTarget(shopId,productId),null);
});
test('fixed explicit floors select nearest cent without a discount step',t=>{
 const f=fixed(t),task=f.j.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'fixed-floor'},at),probe=observation(task,{errorsById:{'5000000000000000765':['活动价不得低于50.01元']}}),review=makePriceReviews(task,probe,at)[0];
 assert.deepEqual(review.rows.map(s=>s.saleFen),[5001,8743]);assert.equal(isAutomaticPriceIncrease(review),true);assert.equal(selectClosestPriceStep({...f.plan.skus[0],priceMode:'fixed'},{minFen:5001}).saleFen,5001);
 assert.throws(()=>selectClosestPriceStep({...f.plan.skus[0],priceMode:'fixed'},{maxDiscount:50}),{code:'PRICE_RULE_UNKNOWN'});
});
test('known official fixed-price template upper bound blocks candidates while preserving higher history',t=>{
 const f=fixed(t);f.baseline.skus[0].saleFen=12000;assert.ok(validateHistorical(f.baseline));assert.equal(fixedActivityMaxFen(f.baseline.skus[0]),11727);
 const p=planOriginalRestore(f.baseline,f.current,f.policy,at);assert.equal(p.skus[0].saleFen,12000);
 assert.throws(()=>selectClosestPriceStep({...p.skus[0],priceMode:'fixed'},{minFen:12000}),{code:'NO_FEASIBLE_PRICE'});
 assert.throws(()=>selectClosestPriceStep({...p.skus[0],priceMode:'fixed'},{minFen:11728}),{code:'NO_FEASIBLE_PRICE'});
 assert.equal(f.baseline.skus[0].saleFen,12000);
});
test('fixed dual automatic approval accepts only fresh non-reducing exact amounts',t=>{
 const f=fixed(t,{dual:true}),next=dual(f,{errors:{'5000000000000000765':['活动价不得低于50.01元']}}),approved=f.j.approveDualActivityDecision(shopId,productId,next.decision.pairKey,at);
 assert.equal(approved.priceMode,'fixed');assert.equal(approved.approvalKind,'automatic-price-increase');assert.deepEqual(approved.rows.map(r=>r.saleFen),[5001,8743]);
 const target=applyPriceTarget(f.plan,approved);f.j.assertPricePlans(shopId,[target]);assert.ok(target.skus.every((r,i)=>r.saleFen>=f.plan.skus[i].saleFen));
});
test('fixed exact lowering intent revalidates every amount and ordinary Journal gates',t=>{
 const f=fixed(t,{dual:true}),inputs=approvalInputs(f),before=fingerprint(f.j.priceTargets(shopId)),intent=createPriceApprovalIntent(inputs);
 assert.equal(intent.desired.priceMode,'fixed');assert.equal(intent.authorizesPriceChange,false);assert.equal(fingerprint(f.j.priceTargets(shopId)),before);
 const next=approvalInputs(f,dual(f,{now:at+1000,caps:{'限时抢购':4321,'限量抢购':4209}})),result=validateFreshPriceIntent(intent,next);
 assert.equal(result.ready,true,JSON.stringify(result));const approved=f.j.decidePriceReview(shopId,result.args.reviewId,result.args.key,'approve',{...result.args,historicalFingerprint:f.plan.historicalFingerprint,approvalContext:'recovery-blockers'},next.now);
 const guarded=applyPriceTarget(f.plan,approved);assert.deepEqual(guarded.skus.map(s=>[s.discount,s.saleFen]),[[null,4321],[null,4321]]);f.j.assertPricePlans(shopId,[guarded]);
 assert.deepEqual(guarded.skus.map(s=>s.originalSaleFen),[4999,8743]);assert.deepEqual(f.j.histories(shopId)[0].skus.map(s=>s.saleFen),[4999,8743]);
 guarded.skus[0].saleFen--;assert.throws(()=>f.j.assertPricePlans(shopId,[guarded]),{code:'PRICE_APPROVAL_CHANGED'});
});
test('fixed manual approval passes exact prices and refuses a one-fen revalidation change',t=>{
 const f=fixed(t,{dual:true}),input=approvalInputs(f);input.option=manualPriceOption(input.review,[{id:'5000000000000000765',saleFen:4321},{id:'5000000000000000766',saleFen:4320}],at);input.args.optionId=input.option.id;input.args.optionKey=input.option.key;
 const intent=createPriceApprovalIntent(input),next=approvalInputs(f,dual(f,{now:at+1000,caps:{'限时抢购':4321,'限量抢购':4209}}));next.option=manualPriceOption(next.review,intent.desired.rows.map(r=>({id:r.id,saleFen:r.saleFen})),next.now);
 const result=validateFreshPriceIntent(intent,next);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.args.optionId,'manual-fixed-price');assert.deepEqual(result.args.manualPrices,intent.desired.rows.map(r=>({id:r.id,saleFen:r.saleFen})));
 next.option.rows[0].saleFen--;assert.equal(validateFreshPriceIntent(intent,next).ready,false);
});
for(const [label,inputs] of [['missing SKU',[{id:'5000000000000000765',saleFen:4300}]],['duplicate SKU',[{id:'5000000000000000765',saleFen:4300},{id:'5000000000000000765',saleFen:4300}]],['fractional amount',[{id:'5000000000000000765',saleFen:4300.1},{id:'5000000000000000766',saleFen:4300}]],['discount disguise',[{id:'5000000000000000765',saleFen:4300,discount:35},{id:'5000000000000000766',saleFen:4300}]],['exceeds explicit cap',[{id:'5000000000000000765',saleFen:4322},{id:'5000000000000000766',saleFen:4300}]]])test('fixed manual amount rejects '+label,t=>{const f=fixed(t,{dual:true}),r=approvalInputs(f).review;assert.throws(()=>manualPriceOption(r,inputs,at));assert.equal(f.j.priceTarget(shopId,productId),null);});
test('fixed limited plans retain exact quota and label instead of zero-discount',t=>{
 const f=fixed(t,{limited:true}),task=f.j.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'fixed-limited'},at);
 assert.match(task.title,/一口价/);assert.equal(f.plan.activityLimit,1000);assert.ok(proveDraft(task,observation(task),at));const altered=observation(task);altered.productLimits[0].activityLimit++;assert.throws(()=>proveDraft(task,altered,at),{code:'LIMITED_READBACK'});
});
test('fixed service restores exact amounts once and remains idle when activity exists',async t=>{
 const f=serviceFixture(t);await f.service.tick();const task=f.j.list(shopId)[0];assert.equal(task?.phase,'verified',task?.reason);assert.equal(task.submitAttempts,1);assert.equal(f.state.submits,1);assert.deepEqual(task.plans[0].skus.map(s=>s.saleFen),[4999,8743]);assert.equal(task.receipt.priceMode,'fixed');
 await f.service.tick();assert.equal(f.state.submits,1);assert.equal(f.j.list(shopId).length,1);
});
test('fixed service with price caps stops before any submit and exposes both exact human proposals',async t=>{
 const f=serviceFixture(t,{cap:4321});await f.service.tick();assert.equal(f.state.submits,0);assert.equal(f.state.prepared.length,0);assert.equal(f.j.priceTarget(shopId,productId),null);
 const decision=getDualActivityDecision(f.j,shopId,productId,at);assert.equal(decision.approvalAllowed,true);assert.ok(decision.schemes.every(s=>s.classification==='reduction-required'&&s.review.priceMode==='fixed'&&s.candidate.rows.every(r=>r.saleFen===4321&&r.discount===null)));
});
test('fixed unknown submission retries independent readback without a second submit',async t=>{
 const f=serviceFixture(t,{dropReadback:true});await f.service.tick();const task=f.j.list(shopId)[0];assert.equal(task?.phase,'unknown',task?.reason);assert.equal(f.state.submits,1);
 await f.service.tick();assert.equal(f.state.submits,1);assert.equal(f.j.get(task.id).phase,'verified');assert.ok(f.state.readbacks>=2);
});
test('fixed ratio optimizer matches exhaustive integer-fen optimum on bounded examples',()=>{
 let seed=42;const rand=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
 for(let round=0;round<80;round++){
  const skus=[0,1,2].map(i=>({priceMode:'fixed',id:String(500001+i),baseFen:15,discount:null,saleFen:1+rand(15)})),ratio=[{numerator:3,denominator:2},{numerator:5,denominator:3},{numerator:35,denominator:10}][round%3],bounds=skus.map(()=>({minFen:1+rand(3),maxFen:8+rand(8)}));
  const score=rows=>{const deltas=rows.map((r,i)=>r.saleFen-skus[i].saleFen),reductions=deltas.reduce((n,x)=>n+Math.max(0,-x),0),absolute=deltas.reduce((n,x)=>n+Math.abs(x),0);return [Number(reductions>0),absolute,reductions,absolute,deltas.filter(Boolean).length];};
  const better=(a,b)=>a.some((v,i)=>v<b[i]&&a.slice(0,i).every((x,j)=>x===b[j]));let optimum=null;
  for(let a=bounds[0].minFen;a<=Math.min(bounds[0].maxFen,fixedActivityMaxFen(skus[0]));a++)for(let b=bounds[1].minFen;b<=Math.min(bounds[1].maxFen,fixedActivityMaxFen(skus[1]));b++)for(let c=bounds[2].minFen;c<=Math.min(bounds[2].maxFen,fixedActivityMaxFen(skus[2]));c++){
   if(Math.max(a,b,c)*ratio.denominator>Math.min(a,b,c)*ratio.numerator)continue;
   const s=score([a,b,c].map(saleFen=>({saleFen})));if(!optimum||better(s,optimum))optimum=s;
  }
  if(!optimum)assert.throws(()=>selectRatioPrices(skus,ratio,bounds),{code:'NO_FEASIBLE_PRICE'});else {const actual=selectRatioPrices(skus,ratio,bounds);assert.deepEqual(score(actual),optimum,'round '+round);assert.ok(actual.every(r=>r.discount===null));}
 }
});
