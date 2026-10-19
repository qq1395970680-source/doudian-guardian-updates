import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {PriorityWatch} from '../src/priority-watch.mjs';
import {proveDraft} from '../src/policy.mjs';
const now=1792440000000;
function fixture(){
 let clock=now;
 const journal=new Journal(':memory:'),baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'300001',name:'原折扣商品',campaignId:'400001',type:'限时抢购',historyAt:now-10000,
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'600001',name:'原规格',baseFen:10000,discount:60}]};
 journal.remember(baseline);const watch=new PriorityWatch(journal,'900001');watch.observe({id:'400001',status:'进行中'},{complete:true,observedAt:now-1000,products:[{productId:'300001'}]});
 const counts={fresh:0,prechecks:0,submits:0,ordinaryLoss:0,remainingDetails:0},policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true,allowMissingHistoricalSkus:true};
 let submitted=false;
 const listing=()=>({complete:true,observedAt:now,campaigns:submitted?[{id:'400002',status:'进行中'}]:[]});
 const rows=()=>baseline.skus.map(s=>({...s,productId:baseline.productId,saleFen:6000}));
 const platform={listActive:async()=>listing(),
  discover:async({onReadBoundary})=>{const result=await onReadBoundary?.({listing:listing(),reads:[]});if(result?.refreshRequired)return{baselines:[],activeComplete:false,priorityRefreshRequired:true};counts.remainingDetails++;return{baselines:[],activeComplete:false};},
  loss:async(_baseline,options)=>{if(!options?.fresh){counts.ordinaryLoss++;throw Error('must use a new product scoped read');}counts.fresh++;return{complete:true,active:submitted,campaignId:submitted?'400002':null,lossKey:'fresh-absence',observedAt:clock};},
  precheck:async()=>{counts.prechecks++;return{shopId:'900001',productId:'300001',complete:true,observedAt:clock,skus:structuredClone(baseline.skus)};},
  prepare:async task=>({observation:{kind:'draft',shopId:'900001',title:task.title,complete:true,observedAt:clock,type:baseline.type,rules:baseline.rules,rows:rows(),warnings:[],dialogs:[],startAt:clock,endAt:clock+48*3600000}}),
  submit:async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,clock));counts.submits++;submitted=true;},
  readback:async task=>submitted?{complete:true,shopId:'900001',title:task.title,observedAt:clock,campaignId:'400002',status:'进行中',type:baseline.type,rules:baseline.rules,rows:rows()}:null,
  release:async()=>{}};
 const service=new GuardianService({journal,platform,policy,now:()=>clock});
 return{journal,baseline,counts,platform,service,policy,advance:ms=>clock+=ms};
}

test('a newly missing known campaign is independently restored before the rest of the store scan',async()=>{
 const f=fixture();try{await f.service.tick();assert.equal(f.counts.submits,1);assert.equal(f.counts.fresh,1);assert.equal(f.counts.prechecks,1);
  assert.equal(f.counts.ordinaryLoss,0);assert.equal(f.counts.remainingDetails,0);assert.equal(f.service.status().verified,1);assert.equal(f.service.priorityResume,true);
  assert.equal(f.service.lastRun,null,'a priority recovery is not a completed full-store patrol');
 }finally{f.journal.close();}
});

test('a missing hint does not create when a fresh query finds another current campaign',async()=>{
 const f=fixture();f.platform.loss=async(_b,o)=>{assert.equal(o.fresh,true);f.counts.fresh++;return{complete:true,active:true,campaignId:'400002',observedAt:now};};
 try{await f.service.tick();assert.equal(f.counts.fresh,1);assert.equal(f.counts.prechecks,0);assert.equal(f.counts.submits,0);}finally{f.journal.close();}
});

for(const mode of ['excluded','incomplete','changed-price'])test('priority recovery retains business guards: '+mode,async()=>{
 const f=fixture();if(mode==='excluded')f.policy.excludedProductIds=['300001'];
 if(mode==='incomplete')f.platform.loss=async()=>({complete:false,active:false});
 if(mode==='changed-price')f.platform.precheck=async()=>({shopId:'900001',productId:'300001',complete:true,observedAt:now,skus:[{...f.baseline.skus[0],baseFen:11000}]});
 try{await f.service.tick();assert.equal(f.counts.submits,0);assert.equal(f.journal.list('900001').length,0);}finally{f.journal.close();}
});

test('unknown priority submit persists and is never retried by another boundary or restart',async()=>{
 const f=fixture();f.platform.submit=async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,now));f.counts.submits++;throw Error('connection lost');};f.platform.readback=async()=>null;
 try{await f.service.tick();assert.equal(f.service.status().unknown,1);await f.service.tick();
  const restarted=new GuardianService({journal:f.journal,platform:f.platform,policy:f.policy,now:()=>now});await restarted.tick();assert.equal(f.counts.submits,1);assert.equal(restarted.status().unknown,1);
 }finally{f.journal.close();}
});

test('a campaign lost during a long detail scan is checked at the next drained boundary',async()=>{
 const f=fixture(),initial={complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'}]};
 f.platform.discover=async({onReadBoundary})=>{
  assert.equal(await onReadBoundary({listing:initial,reads:[]}),null);f.advance(31000);
  const result=await onReadBoundary({listing:initial,reads:[]});assert.equal(result.refreshRequired,true);
  return{baselines:[],activeComplete:false,priorityRefreshRequired:true};
 };
 try{await f.service.tick();assert.equal(f.counts.submits,1);assert.equal(f.service.priorityResume,true);}finally{f.journal.close();}
});

test('slow legacy prechecks cannot delay a newly lost current product until their whole queue ends',async()=>{
 const f=fixture(),initial={complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'}]};let oldReads=0;
 for(let n=1;n<=5;n++)f.journal.remember({...f.baseline,productId:String(300001+n),campaignId:String(410001+n)});
 f.platform.inventory={listing:initial};
 f.platform.discover=async({onReadBoundary})=>{await onReadBoundary({listing:initial,reads:[]});return{baselines:[],activeComplete:true};};
 const loss=f.platform.loss,precheck=f.platform.precheck;
 f.platform.loss=async(b,o)=>o?.fresh?loss(b,o):{complete:true,active:b.productId==='300001',lossKey:'old-'+b.productId,observedAt:now};
 f.platform.precheck=async b=>{if(b.productId==='300001')return precheck(b);oldReads++;f.advance(20000);throw Object.assign(Error('not found'),{code:'NOT_FOUND'});};
 try{await f.service.tick();assert.equal(f.counts.submits,1);assert.equal(oldReads,2);assert.equal(f.service.priorityResume,true);}finally{f.journal.close();}
});

test('a product removed from a complete current detail is independently checked before unrelated details',async()=>{
 const f=fixture(),initial={complete:true,observedAt:now,campaigns:[{id:'400001',status:'进行中'}]};
 f.platform.discover=async({onReadBoundary})=>{
  assert.equal(await onReadBoundary({listing:initial,reads:[]}),null);
  const result=await onReadBoundary({listing:initial,reads:[{campaign:initial.campaigns[0],detail:{complete:true,observedAt:now,products:[]}}]});
  assert.equal(result?.refreshRequired,true);
  return{baselines:[],activeComplete:false,priorityRefreshRequired:true};
 };
 try{await f.service.tick();assert.equal(f.counts.fresh,1);assert.equal(f.counts.submits,1);assert.equal(f.service.status().verified,1);}finally{f.journal.close();}
});

test('excluded hints do not discard reusable monitoring pages',async()=>{
 const f=fixture();let closed=0;f.policy.excludedProductIds=['300001'];f.platform.closeMonitorPages=async()=>closed++;
 try{await f.service.tick();assert.equal(f.counts.fresh,0);assert.equal(closed,0);}finally{f.journal.close();}
});

test('monitoring pages close before the first fresh eligible recovery query',async()=>{
 const f=fixture();let closed=false;f.platform.closeMonitorPages=async()=>{closed=true;};const loss=f.platform.loss;
 f.platform.loss=async(...args)=>{assert.equal(closed,true);return loss(...args);};
 try{await f.service.tick();assert.equal(f.counts.submits,1);}finally{f.journal.close();}
});
