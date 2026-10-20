import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {CampaignConversion} from '../src/campaign-conversion.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {planOriginalRestore,saleFen} from '../src/policy.mjs';

function fixture(){
 const shopId='900001',now=Date.now(),journal=new Journal(':memory:'),policy={shopId,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const rules={noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true};
 const baselines=Array.from({length:3},(_,i)=>({source:'verified-platform-history',complete:true,shopId,productId:String(300001+i),
  name:'商品'+i,campaignId:'400001',type:'限量抢购',rules,durationMs:7*86400000,activityLimit:1000,
  skus:[{id:String(500001+i),name:'规格',baseFen:10000,discount:60}]}));
 const plans=baselines.map(b=>planOriginalRestore(b,{...b,observedAt:now},policy,now));
 const task={id:'test-task',shopId,title:'守护2-test-task',phase:'verified',plans,receipt:{campaignId:'400002',verifiedAt:now-1000}};
 const campaign={id:'400002',name:task.title,status:'进行中',type:'限量抢购',risk:true,startAt:now-100000,endAt:now-100000+7*86400000};
 const detail={complete:true,observedAt:now,rules,products:plans.slice(0,2).map(p=>({...p,skus:p.skus.map(s=>({...s,saleFen:saleFen(s.baseFen,s.discount)}))})),
  removalExport:{source:'live-platform-removal-export',shopId,campaignId:campaign.id,complete:true,observedAt:now,
   records:[{productId:'300003',name:'商品2',reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]}};
 const platform=new DoudianPlatform({browser:{},policy,journal});
 platform.list=async()=>({complete:true,observedAt:Date.now(),campaigns:[campaign]});
 platform.detail=async()=>structuredClone(detail);
 return{journal,platform,task,campaign,detail,baselines,policy};
}
test('handoff preserves historical success while auditing current products and later removals separately',async()=>{
 const x=fixture();
 try{
  const audit=await x.platform.auditVerifiedTask(x.task);
  assert.equal(audit.complete,true);assert.equal(audit.taskId,x.task.id);
  assert.deepEqual(audit.products.map(p=>p.status),['current','current','removed']);
  assert.equal(audit.products[2].removal.productId,'300003');
  assert.equal(x.task.phase,'verified');assert.equal(x.task.receipt.campaignId,'400002');
 }finally{x.journal.close();}
});
test('an inactive risk campaign may retain old product rows: exact live exports prove later removal, never current success',async()=>{
 const x=fixture();
 try{
  x.campaign.status='已失效';
  x.detail.removalExport.records=x.task.plans.map(p=>({productId:p.productId,name:p.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}));
  const result=await x.platform.auditVerifiedTask(x.task);
  assert.ok(result.products.every(p=>p.status==='removed'));
  assert.ok(result.products.every(p=>!p.receipt));
 }finally{x.journal.close();}
});
for(const mode of ['unexplained-missing','wrong-campaign','stale-export','changed-price','ambiguous','never-verified'])
test('handoff cannot treat unknown or changed results as successful: '+mode,async()=>{
 const x=fixture();
 try{
  if(mode==='unexplained-missing')delete x.detail.removalExport;
  if(mode==='wrong-campaign')x.campaign.id='400003';
  if(mode==='stale-export')x.detail.removalExport.observedAt-=180000;
  if(mode==='changed-price')x.detail.products[0].skus[0].saleFen--;
  if(mode==='ambiguous')x.detail.products[0].removalAmbiguous=true;
  if(mode==='never-verified')x.task.phase='unknown';
  await assert.rejects(()=>x.platform.auditVerifiedTask(x.task));
 }finally{x.journal.close();}
});
test('known later removal does not freeze handoff of a verified shop, but stays visibly unresolved',async()=>{
 const x=fixture(),service=new GuardianService(x),conversion=new CampaignConversion(service);
 try{
  x.journal.get=id=>id===x.task.id?x.task:null;
  x.journal.list=()=>[x.task];
  conversion.save({shopId:x.policy.shopId,status:'captured',campaigns:[{phase:'cancelled'}],
   products:x.baselines.map(b=>({productId:b.productId,phase:'verified',taskId:x.task.id}))});
  await conversion.finish();
  const state=conversion.state();
  assert.equal(state.status,'complete');
  assert.equal(state.handoff.currentProducts,2);assert.equal(state.handoff.removedProducts,1);
  assert.equal(state.products[2].currentAudit.status,'removed');
  assert.equal(state.products[2].phase,'verified');
  assert.equal(x.task.phase,'verified');
 }finally{x.journal.close();}
});
test('unexplained missing products keep migration unfinished and never trigger a write',async()=>{
 const x=fixture(),service=new GuardianService(x),conversion=new CampaignConversion(service);
 try{
  x.journal.get=()=>x.task;x.journal.list=()=>[x.task];delete x.detail.removalExport;
  conversion.save({shopId:x.policy.shopId,status:'captured',campaigns:[{phase:'cancelled'}],
   products:x.baselines.map(b=>({productId:b.productId,phase:'verified',taskId:x.task.id}))});
  await assert.rejects(()=>conversion.finish());
  assert.equal(conversion.state().status,'captured');
 }finally{x.journal.close();}
});
