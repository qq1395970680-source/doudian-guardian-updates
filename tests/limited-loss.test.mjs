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
