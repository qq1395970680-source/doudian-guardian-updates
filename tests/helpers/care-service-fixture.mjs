import {AccountRegistry} from '../../src/accounts.mjs';
import {setCareRecoveryPolicy} from '../../src/care-recovery-policy.mjs';
import {proveDraft} from '../../src/policy.mjs';

export function careServiceFixture(journal,{now=Date.now(),mixed=false,ratio=false,dropReadback=false}={}){
 let clock=now;const accounts=new AccountRegistry(journal);accounts.register({shopId:'900001'},'signin-care-fixture');accounts.authorizeOriginal('900001');setCareRecoveryPolicy(journal,'900001',{enabled:true,acceptNonReducingRecovery:true},now);
 const policy={shopId:'900001',excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'3500000000000000001',name:'省心守护测试商品',campaignId:'4500000000000000001',type:'限量抢购',durationMs:7*86400000,activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},skus:[{id:'5500000000000000001',name:'规格甲',baseFen:10000,discount:ratio?50:60},{id:'5500000000000000002',name:'规格乙',baseFen:ratio?50000:12000,discount:ratio?50:60}]};
 journal.remember(baseline,now);const state={submits:0,prechecks:0,reads:[],campaigns:new Map(),active:false,floorFen:6100,capFen:null,lossRevision:0};
 const observe=task=>({source:'live-platform-draft',kind:'draft',shopId:policy.shopId,title:task.title,complete:true,observedAt:clock,type:task.plans[0].type,rules:task.plans[0].rules,startAt:clock,endAt:clock+(task.plans[0].durationMs||48*3600000),productLimits:task.plans.map(p=>({productId:p.productId,activityLimit:1000,shared:true})),rows:task.plans.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId,errors:[]}))),warnings:[],dialogs:[]});
 const platform={
  discover:async()=>({baselines:[baseline],activeComplete:true}),
  loss:async b=>({complete:true,observedAt:clock,active:state.active&&b.productId===baseline.productId,campaignId:state.active?'4500000000000000002':null,lossKey:'care-loss:'+b.productId+':'+state.lossRevision,...(ratio?{removal:{productId:b.productId,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'},removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:policy.shopId,campaignId:b.campaignId,activityType:'限量抢购',observedAt:clock,sha256:'a'.repeat(64),record:{productId:b.productId,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}}}:{})}),
  precheck:async b=>{state.prechecks++;return {...structuredClone(b),observedAt:clock};},
  prepare:async task=>{const observation=observe(task);if(!ratio){for(const row of observation.rows){if(row.id===baseline.skus[0].id&&row.saleFen<state.floorFen)row.errors=['活动价不得低于'+state.floorFen/100+'元'];if(state.capFen!=null&&row.id===baseline.skus[0].id&&row.saleFen>state.capFen)row.errors=['活动价不得高于'+state.capFen/100+'元'];if(mixed&&row.id===baseline.skus[1].id&&row.saleFen>7000)row.errors=['活动价不得高于70元'];}observation.warnings=[...new Set(observation.rows.flatMap(r=>r.errors))];if(observation.warnings.length)throw Object.assign(new Error('平台明确价格要求'),{code:'PRICE_REVIEW_REQUIRED',detail:{priceProbe:observation}});}return {observation};},
  submit:async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,clock));state.submits++;state.active=true;state.campaigns.set(task.title,{...structuredClone(draft.observation),kind:'activity',status:'进行中',campaignId:'4500000000000000002'});},
  readback:async task=>{state.reads.push(task.id);if(dropReadback){dropReadback=false;return null;}return state.campaigns.get(task.title)||null;},release:async()=>{}
 };
 return {policy,baseline,platform,state,now:()=>clock,advance:ms=>{clock+=ms;}};
}
