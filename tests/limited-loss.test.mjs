import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
const baseline={shopId:'900001',productId:'300001',campaignId:'400001',type:'限量抢购'};
const platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'}});
const campaign={id:'400001',status:'已失效',type:'限量抢购',risk:true};
const detail=p=>new Map([['400001',{complete:true,products:[{productId:'300001',...p}]}]]);
test('limited sold out, natural end or unexplained absence never authorizes restocking',()=>{
 for(const [c,p] of [
  [{...campaign,status:'已结束',risk:false},{soldOut:true,removalConfirmed:true}],
  [{...campaign,status:'已结束',risk:false},{}],
  [campaign,{removalConfirmed:true,removalRiskConfirmed:false}],
  [campaign,{removalConfirmed:true,removalRiskConfirmed:true,soldOut:true}]
 ])assert.throws(()=>platform.lossFrom(baseline,{complete:true,campaigns:[c]},detail(p),true,true),{code:'LIMITED_LOSS_UNPROVEN'});
});
test('limited exact product risk removal allows restoration, other product risk is insufficient',()=>{
 assert.equal(platform.lossFrom(baseline,{complete:true,campaigns:[campaign]},detail({removalConfirmed:true,removalRiskConfirmed:true}),true,true).active,false);
 assert.throws(()=>platform.lossFrom(baseline,{complete:true,campaigns:[campaign]},new Map([['400001',{complete:true,products:[{productId:'300002',removalConfirmed:true,removalRiskConfirmed:true}]}]]),true,true),{code:'LIMITED_LOSS_UNPROVEN'});
});

test('a fresh exact official export proves a removed product omitted from current detail; another product or expired campaign cannot',()=>{
 const c={...campaign,status:'进行中',endAt:Date.now()+60000},proof={source:'live-platform-removal-export',shopId:'900001',campaignId:c.id,
  observedAt:Date.now(),complete:true,sha256:'a'.repeat(64),records:[{productId:'300001',reason:'明确剔除原因'}]};
 const listing={complete:true,campaigns:[c]},details=exported=>new Map([[c.id,{complete:true,products:[],removalExport:exported}]]);
 const result=platform.lossFrom(baseline,listing,details(proof),true,true);
 assert.equal(result.active,false);assert.equal(result.removal.reason,'明确剔除原因');
 for(const change of [{shopId:'900002'},{campaignId:'400002'},{observedAt:Date.now()-120001},{records:[{productId:'300002',reason:'明确剔除原因'}]},{source:'diagnostic'}])
  assert.throws(()=>platform.lossFrom(baseline,listing,details({...proof,...change}),true,true),{code:'LIMITED_LOSS_UNPROVEN'});
 assert.throws(()=>platform.lossFrom(baseline,{complete:true,campaigns:[{...c,endAt:Date.now()-1}]},details(proof),true,true),{code:'LIMITED_LOSS_UNPROVEN'});
});

for(const mode of ['verified-task-title','current-index-title','complete-list'])
test('fresh loss follows the original activity when product search omits its removed member: '+mode,async()=>{
 const now=Date.now(),c={...campaign,name:'守护2-origin',status:'进行中',endAt:now+86400000},calls=[];
 const adapter=new DoudianPlatform({browser:{},policy:{shopId:'900001'},
  ...(mode==='verified-task-title'?{journal:{list:()=>[{phase:'verified',title:c.name,plans:[baseline],receipt:{campaignId:c.id,verifiedAt:now}}]}}:{})});
 if(mode==='current-index-title')adapter.inventory={listing:{campaigns:[c]}};
 adapter.list=async query=>{calls.push(query);return{complete:true,observedAt:now,campaigns:query?.productId?[]:[c]};};
 adapter.detail=async found=>{assert.equal(found.id,c.id);return{complete:true,observedAt:now,products:[],
  removalExport:{source:'live-platform-removal-export',shopId:'900001',campaignId:c.id,complete:true,observedAt:now,
   records:[{productId:baseline.productId,reason:'明确退出'}]}};};
 const proof=await adapter.loss(baseline,{fresh:true});
 assert.equal(proof.active,false);assert.equal(proof.removal.productId,baseline.productId);assert.equal(calls.length,2);
 if(mode!=='complete-list')assert.equal(calls[1].title,c.name);
});
for(const mode of ['partial-product-list','partial-origin-list','wrong-id','expired'])
test('origin lookup is fresh evidence, not permission to infer loss: '+mode,async()=>{
 const now=Date.now(),adapter=new DoudianPlatform({browser:{},policy:{shopId:'900001'}}),c={...campaign,name:'来源',endAt:now+60000};
 adapter.list=async query=>({complete:!(query?.productId?mode==='partial-product-list':mode==='partial-origin-list'),
  observedAt:now,campaigns:query?.productId?[]:[{...c,...(mode==='wrong-id'?{id:'400002'}:{}),...(mode==='expired'?{endAt:now-1}:{})}]});
 adapter.detail=async found=>({complete:true,observedAt:now,products:[],removalExport:{source:'live-platform-removal-export',
  shopId:'900001',campaignId:found.id,complete:true,observedAt:now,records:[{productId:baseline.productId,reason:'退出'}]}});
 await assert.rejects(()=>adapter.loss(baseline,{fresh:true}));
});
