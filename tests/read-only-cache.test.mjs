import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {fingerprint} from '../src/policy.mjs';
for(const scenario of ['read-only-fresh','normal-execution','expired','changed-listing'])test(`active detail reuse is restricted: ${scenario}`,async()=>{
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{},policy:{shopId:'900001'},journal});let reads=0;
 const c={id:'400001',name:'已核对活动',type:'限时抢购',status:'进行中',startAt:Date.now()-10000,risk:false};
 const detail={complete:true,products:[],rules:{},observedAt:Date.now()-(scenario==='expired'?900001:1000)};
 journal.putSettings('campaign:'+c.id,{key:fingerprint(c),detail});
 platform.list=async()=>({complete:true,campaigns:[{...c,...(scenario==='changed-listing'?{risk:true}:{})}],observedAt:Date.now()});
 platform.detail=async()=>{reads++;return {...detail,observedAt:Date.now()};};
 try{const result=await platform.discover(scenario==='normal-execution'?undefined:{readOnlyReuseMaxAgeMs:900000});assert.equal(result.activeComplete,true);assert.equal(reads,scenario==='read-only-fresh'?0:1);}finally{journal.close();}
});
