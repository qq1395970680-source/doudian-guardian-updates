import {planOriginalRestore,proveDraft} from '../../src/policy.mjs';
import {makePriceReviews} from '../../src/price-review.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setPriceIncreasePolicy} from '../../src/price-increase-policy.mjs';

export function automaticFollowupFixture(journal,count,now,{skuCount=10}={}){
 new AccountRegistry(journal).register({shopId:'900001'},'signin-followup-fixture');
 setPriceIncreasePolicy(journal,'900001',{enabled:true,acceptHigherPricesAndRisk:true},now);
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const baselines=Array.from({length:count},(_,i)=>({shopId:policy.shopId,productId:String(3500000000000000000n+BigInt(i)),name:'自动提价后续商品'+i,
  source:'verified-platform-history',complete:true,campaignId:'4500000000000000001',type:'限量抢购',durationMs:7*86400000,activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
  skus:Array.from({length:skuCount},(_,k)=>({id:String(5500000000000000000n+BigInt(i*100+k)),name:'规格'+k,baseFen:10000+k*100,discount:60}))}));
 const observe=(task,rows)=>({source:'live-platform-draft',kind:'draft',shopId:task.shopId,title:task.title,complete:true,observedAt:now,
  type:task.plans[0].type,rules:task.plans[0].rules,startAt:now,endAt:now+7*86400000,
  productLimits:task.plans.map(p=>({productId:p.productId,activityLimit:1000,shared:true})),rows,warnings:[],dialogs:[]});
 for(const baseline of baselines){
  journal.remember(baseline,now);const plan=planOriginalRestore(baseline,{...baseline,observedAt:now},policy,now);
  const task=journal.enqueue(policy.shopId,[plan],{complete:true,observedAt:now,lossKey:'initial-loss:'+baseline.productId},now);
  const probe=observe(task,plan.skus.map((s,k)=>({...s,productId:plan.productId,errors:k?[]:['活动价不得低于61元']})));
  probe.warnings=['活动价不得低于61元'];
  const review=journal.recordPriceReview(makePriceReviews(task,probe,now)[0],now);
  journal.transition(task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED',retryAfter:now+900000},now);
  journal.approvePriceIncrease(policy.shopId,review.id,review.key,plan.historicalFingerprint,now);
 }
 const counts={precheckGroups:[],lossGroups:[],submits:0,risks:0},active=new Set(),campaigns=new Map();
 const read=b=>({shopId:b.shopId,productId:b.productId,complete:true,observedAt:now,skus:structuredClone(b.skus)});
 const loss=b=>({complete:true,observedAt:now,active:active.has(b.productId),lossKey:'fresh-loss:'+b.productId});
 const platform={
  precheck:async b=>{counts.precheckGroups.push([b.productId]);return read(b);},
  precheckBatch:async bs=>{counts.precheckGroups.push(bs.map(b=>b.productId));return bs.map(read);},
  loss:async b=>{counts.lossGroups.push([b.productId]);return loss(b);},
  lossBatch:async bs=>{counts.lossGroups.push(bs.map(b=>b.productId));return bs.map(b=>({productId:b.productId,loss:loss(b)}));},
  prepare:async task=>({observation:observe(task,task.plans.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))))}),
  submit:async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,now));counts.submits++;
   task.plans.forEach(p=>active.add(p.productId));campaigns.set(task.title,{...structuredClone(draft.observation),kind:'activity',status:'进行中',campaignId:String(4500000000000000001n+BigInt(counts.submits))});},
  readback:async task=>campaigns.get(task.title)||null,release:async()=>{}
 };
 return {policy,baselines,platform,counts};
}
