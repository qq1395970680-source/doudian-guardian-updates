import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fingerprint} from '../../src/policy.mjs';
import {dualProbePlan,makeDualActivityDecision} from '../../src/dual-activity-recovery.mjs';
import {dualDraftObservation} from './dual-activity-fixture.mjs';

const targetState=(journal,shopId)=>fingerprint({targets:journal.db.prepare('SELECT * FROM price_targets WHERE shop=? ORDER BY product').all(shopId),approved:journal.priceReviews(shopId).filter(r=>r.status==='approved')});

// These UI fixtures deliberately have no running scheduler. Exercise the real
// 202 intent and fresh service validation explicitly, instead of bypassing it
// or pretending that clicking consent immediately approves a financial target.
export function exactPriceUiRevalidation(fixture){
 const {journal,service}=fixture,baseline=fixture.f.baseline,plan=fixture.plan||fixture.f.plan,pair=fixture.decision||fixture.pair,platform=service.platform,calls=[],financial=[];
 const initial=structuredClone(pair.probes);
 service.immediateEnabled=false;
 platform.loss=async b=>({complete:true,active:false,ambiguous:false,observedAt:Date.now(),lossKey:'ui-fresh-price-confirmation:'+b.productId});
 platform.precheck=async b=>({...structuredClone(b),complete:true,offShelf:false,activeCampaign:false,observedAt:Date.now()});
 platform.priceCheck=async task=>{
  const type=task.plans[0].type,seed=initial.find(p=>p.type===type);assert.ok(seed?.observation,'A fresh type needs its own existing fixture evidence');
  calls.push({type,rows:task.plans[0].skus.map(s=>({id:s.id,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen}))});
  return dualDraftObservation(task,{now:Date.now(),errorsById:Object.fromEntries(seed.observation.rows.map(row=>[row.id,[...(row.errors||[])]]))});
 };
 for(const name of ['prepare','submit','confirmOriginalRisk','resumeOriginalRisk','cancelCampaign'])platform[name]=async()=>{financial.push(name);assert.fail('A price confirmation UI test must not enter '+name);};
 return{calls,financial,async assertNewerProposalVisible(){
  const target=journal.priceTarget(plan.shopId,plan.productId);assert.equal(target.status,'approved');await new Promise(resolve=>setTimeout(resolve,2));
  const current=await platform.precheck(baseline),nextPlan=service.restorePlan(baseline,current),at=Date.now(),first=nextPlan.skus[0],cap=first.saleFen-200;
  const probes=['限时抢购','限量抢购'].map(type=>{const task={id:randomUUID(),title:'new-current-target-ui-'+type,shopId:plan.shopId,phase:'queued',plans:[dualProbePlan(nextPlan,type)],submitAttempts:0,riskAttempts:0};return{type,task,observation:dualDraftObservation(task,{now:at,errorsById:{[first.id]:['活动价不得高于'+cap/100+'元']}})};});
  const next=journal.recordDualActivityDecision(makeDualActivityDecision({plan:nextPlan,probes,now:at}),at),displayed=await(await fetch(fixture.app.url+'/api/price-reviews/item?productId='+plan.productId)).json();
  assert.equal(displayed.review.status,'pending');assert.notEqual(displayed.review.id,target.id,'A genuinely newer proposal must remain visible over the older approved target');assert.equal(displayed.review.previousApprovalId,target.id);assert.equal(displayed.review.dualPairKey,next.pairKey);assert.equal(journal.priceTarget(plan.shopId,plan.productId).id,target.id);assert.deepEqual(financial,[]);
 },async confirm({page,dialog,button}){
  const before=targetState(journal,plan.shopId),responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/price-reviews/decide'&&response.request().method()==='POST');
  await button.click();const response=await responsePromise,body=await response.json();assert.equal(response.status(),202);assert.equal(body.queued,true);assert.equal(body.state,'pending-revalidation');assert.equal(body.review,undefined);
  assert.equal(service.priceApprovalIntent(plan.productId).state,'pending');assert.equal(targetState(journal,plan.shopId),before,'Saving an exact consent intent cannot change approved prices');assert.deepEqual(calls,[]);
  await dialog.locator('[data-cancel-price-confirmation]').waitFor();assert.equal(await dialog.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).count(),0);
  await service.revalidateExactPriceIntent(baseline);
  assert.equal(service.priceApprovalIntent(plan.productId).state,'approved');assert.deepEqual(calls.map(c=>c.type).sort(),['限时抢购','限量抢购'].sort());
  const guarded=plan.skus.map(s=>({id:s.id,baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen}));assert.ok(calls.every(c=>fingerprint(c.rows)===fingerprint(guarded)),'Both new dry checks use the previous guarded amounts, never a guessed lower candidate');
  const target=journal.priceTarget(plan.shopId,plan.productId);assert.deepEqual(target.rows.map(r=>[r.id,r.discount,r.saleFen]).sort(),service.priceApprovalIntent(plan.productId).intent.desired.rows.map(r=>[r.id,r.discount,r.saleFen]).sort());
  const displayed=await(await fetch(fixture.app.url+'/api/price-reviews/item?productId='+plan.productId)).json();assert.equal(displayed.review?.id,target.id,'The current freshly approved target must not be hidden by its older, unselected pending peer');assert.equal(displayed.review.status,'approved');
  await dialog.locator('.price-review-heading .badge').filter({hasText:'已确认价格'}).waitFor();assert.deepEqual(financial,[]);return{response:body,target};
 }};
}
