import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
const platform=new DoudianPlatform({browser:{context:{}},policy:{shopId:'900001'}});
const baseline={productId:'300001',campaignId:'400001'};
const ended={id:'400001',status:'已结束',startAt:100,endAt:200};

test('switching between full history and current-only listings does not reset an unchanged missing product retry',()=>{
 const historical=platform.lossFrom(baseline,{campaigns:[ended]},new Map(),true);
 const current=platform.lossFrom(baseline,{campaigns:[]},new Map(),true);
 assert.equal(current.lossKey,historical.lossKey);
});

test('campaign row order does not reset a confirmed removal cooldown',()=>{
 const campaigns=[{id:'400002',status:'进行中'},{id:'400003',status:'进行中'}];
 const details=new Map(campaigns.map(c=>[c.id,{complete:true,products:[{productId:'300001',removalConfirmed:true}]}]));
 const a=platform.lossFrom(baseline,{campaigns},details,true);
 const b=platform.lossFrom(baseline,{campaigns:[...campaigns].reverse()},details,true);
 assert.equal(a.lossKey,b.lossKey);
});

test('fresh per-product evidence still distinguishes a new failed restored campaign for task deduplication',()=>{
 const a=platform.lossFrom(baseline,{campaigns:[ended]},new Map(),true,true);
 const b=platform.lossFrom(baseline,{campaigns:[ended,{...ended,id:'400002',status:'已失效'}]},new Map(),true,true);
 assert.notEqual(a.lossKey,b.lossKey);
});
