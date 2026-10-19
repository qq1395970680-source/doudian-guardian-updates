import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';

const make=()=>{
 const platform=new DoudianPlatform({browser:{context:{}},policy:{shopId:'900001'}});
 return platform;
};
const result=(status,campaigns=[])=>({complete:true,query:{status},observedAt:Date.now(),campaigns});

test('a failed status query waits for the other reader to close before rejecting inventory',async()=>{
 const platform=make();let release,closed=false,settled=false;
 const pending=new Promise(r=>{release=r;});
 platform.list=async({status})=>{if(status==='进行中')throw Object.assign(new Error('read failed'),{code:'READ_ERROR'});await pending;closed=true;return result(status);};
 const operation=platform.listActive();operation.catch(()=>{settled=true;});
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(closed,false);
 release();await assert.rejects(operation,{code:'READ_ERROR'});assert.equal(closed,true);
});

for(const kind of ['incomplete','duplicate-transition','unexpected-status'])test('partial or changing status inventory is rejected: '+kind,async()=>{
 const platform=make();
 platform.list=async({status})=>{
  if(kind==='incomplete')return {...result(status),complete:status==='进行中'};
  if(kind==='duplicate-transition')return result(status,[{id:'400001',status}]);
  return result(status,[{id:status==='进行中'?'400001':'400002',status:status==='进行中'?'已失效':status}]);
 };
 await assert.rejects(platform.listActive(),{code:'ACTIVE_UNKNOWN'});
});

test('only two complete empty current-status queries prove an empty inventory',async()=>{
 const platform=make(),queries=[];
 platform.list=async({status})=>{queries.push(status);return result(status);};
 const inventory=await platform.listActive();
 assert.equal(inventory.complete,true);assert.deepEqual(inventory.campaigns,[]);
 assert.deepEqual(queries.sort(),['未开始','进行中'].sort());
});
