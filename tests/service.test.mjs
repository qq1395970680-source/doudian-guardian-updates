import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {planOriginalRestore,proveDraft} from '../src/policy.mjs';

const now=1792407698000;
function fixture(){
 const baseline={source:'verified-platform-history',complete:true,shopId:'900001',productId:'3000000000000000001',name:'测试',campaignId:'4000000000000000001',type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'5000000000000000001',name:'规格',baseFen:10000,discount:60}]};
 const policy={shopId:'900001',allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const current={shopId:'900001',productId:baseline.productId,complete:true,observedAt:now,skus:baseline.skus};
 const counts={submitted:0,prechecks:0,prepared:0,reads:0};let submitted=false;
 const rows=()=>baseline.skus.map(s=>({...s,productId:baseline.productId,saleFen:6000}));
 const platform={discover:async()=>({baselines:[baseline],activeComplete:true}),loss:async()=>({complete:true,active:submitted,lossKey:'ended-4000000000000000001',observedAt:now}),
  precheck:async()=>{counts.prechecks++;return current;},
  prepare:async task=>{counts.prepared++;return {observation:{kind:'draft',title:task.title,shopId:task.shopId,complete:true,observedAt:now,type:baseline.type,rules:baseline.rules,rows:rows(),warnings:[],dialogs:[],startAt:now,endAt:now+48*3600000}};},
  submit:async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,now));counts.submitted++;submitted=true;},
  readback:async task=>{counts.reads++;return submitted?{complete:true,shopId:task.shopId,title:task.title,observedAt:now,campaignId:'4000000000000000002',status:'进行中',type:baseline.type,rules:baseline.rules,rows:rows()}:null;},release:async()=>{}};
 return {baseline,policy,current,counts,platform};
}
test('no live execution until explicit cutover is enabled',async()=>{
 const f=fixture(),j=new Journal(':memory:');try{const s=new GuardianService({journal:j,...f,policy:{...f.policy,liveEnabled:false},now:()=>now});
  await assert.rejects(s.tick(),{code:'CUTOVER_REQUIRED'});assert.equal(f.counts.submitted,0);
 }finally{j.close();}
});
test('successful create is counted only after independent exact readback and later patrol never duplicates it',async()=>{
 const f=fixture(),j=new Journal(':memory:');try{const s=new GuardianService({journal:j,...f,now:()=>now});await s.tick();
  assert.equal(s.status().verified,1);assert.equal(f.counts.submitted,1);assert.equal(f.counts.reads,1);await s.tick();assert.equal(f.counts.submitted,1);
 }finally{j.close();}
});
test('transport loss after submit never causes a second submit on the next tick',async()=>{
 const f=fixture(),j=new Journal(':memory:');f.platform.submit=async(task,draft,_risk,beforeSubmit)=>{await beforeSubmit(proveDraft(task,draft.observation,now));f.counts.submitted++;throw new Error('connection lost after click');};
 f.platform.readback=async()=>null;
 try{const s=new GuardianService({journal:j,...f,now:()=>now});await s.tick();await s.tick();
  assert.equal(f.counts.submitted,1);assert.equal(s.status().unknown,1);
 }finally{j.close();}
});
test('a lower imported price is blocked before the submit journal or button',async()=>{
 const f=fixture(),j=new Journal(':memory:');const prepare=f.platform.prepare;f.platform.prepare=async task=>{const d=await prepare(task);d.observation.rows[0].saleFen=5900;return d;};
 try{const s=new GuardianService({journal:j,...f,now:()=>now});await s.tick();assert.equal(f.counts.submitted,0);assert.equal(s.status().blocked,1);}
 finally{j.close();}
});

test('incomplete active inventory is a failed patrol before per-product work',async()=>{
 const f=fixture(),j=new Journal(':memory:');let lossReads=0;
 f.platform.discover=async()=>({baselines:[f.baseline],activeComplete:false,errors:[{campaignId:'4000000000000000001',code:'READ_ERROR'}]});
 f.platform.loss=async()=>{lossReads++;throw Error('An incomplete inventory must stop the patrol once');};
 try{const s=new GuardianService({journal:j,...f,now:()=>now});await s.tick();
  assert.equal(s.lastRun.ok,false);assert.equal(s.lastRun.code,'ACTIVE_UNKNOWN');assert.equal(lossReads,0);assert.equal(f.counts.prechecks,0);assert.equal(f.counts.submitted,0);
  assert.equal(j.events().filter(e=>e.kind==='product-blocked').length,0);assert.equal(j.histories('900001').length,1);
 }finally{j.close();}
});
