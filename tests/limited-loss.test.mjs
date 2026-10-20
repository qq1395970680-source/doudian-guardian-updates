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
