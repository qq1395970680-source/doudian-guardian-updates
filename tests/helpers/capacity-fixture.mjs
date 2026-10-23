import {proveDraft} from '../../src/policy.mjs';

export const capacityNow=1792700000000;
export function capacityFixture(journal,{sizes=[501,2,2],currentSizes=sizes}={}){
 const now=capacityNow,policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const baselines=sizes.map((size,i)=>({source:'verified-platform-history',complete:true,shopId:policy.shopId,productId:String(3700000000000000000n+BigInt(i)),name:'容量商品'+i,
  campaignId:'4700000000000000001',type:'限量抢购',rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},durationMs:7*86400000,activityLimit:1000,
  skus:Array.from({length:size},(_,k)=>({id:String(5700000000000000000n+BigInt(i*10000+k)),name:'规格'+k,baseFen:10000+k,discount:60}))}));
 for(const b of baselines)journal.remember(b,now);
 const counts={prechecks:[],submits:0},active=new Set(),campaigns=new Map();
 const read=b=>{counts.prechecks.push(b.productId);const i=baselines.findIndex(x=>x.productId===b.productId);return{shopId:b.shopId,productId:b.productId,complete:true,observedAt:now,skus:structuredClone(b.skus.slice(0,currentSizes[i]))};};
 const loss=b=>({complete:true,active:active.has(b.productId),observedAt:now,lossKey:'capacity-loss:'+b.productId});
 const observation=task=>({source:'live-platform-draft',kind:'draft',shopId:policy.shopId,title:task.title,complete:true,observedAt:now,type:task.plans[0].type,rules:task.plans[0].rules,
  startAt:now,endAt:now+task.plans[0].durationMs,productLimits:task.plans.map(p=>({productId:p.productId,activityLimit:p.activityLimit})),
  rows:task.plans.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),warnings:[],dialogs:[]});
 const platform={discover:async()=>({baselines:[],activeComplete:true}),precheck:async b=>read(b),precheckBatch:async bs=>bs.map(read),loss:async b=>loss(b),
  lossBatch:async bs=>bs.map(b=>({productId:b.productId,loss:loss(b)})),prepare:async task=>({observation:observation(task)}),
  submit:async(task,draft,_risk,before)=>{await before(proveDraft(task,draft.observation,now));counts.submits++;task.plans.forEach(p=>active.add(p.productId));
   campaigns.set(task.title,{...draft.observation,kind:'activity',status:'进行中',campaignId:String(4700000000000000001n+BigInt(counts.submits))});},
  readback:async task=>campaigns.get(task.title)||null,release:async()=>{}};
 return{policy,baselines,platform,counts,observation};
}
