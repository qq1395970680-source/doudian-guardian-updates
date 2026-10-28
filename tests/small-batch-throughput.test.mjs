import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';

for(const size of [1,3,5])test(`large inventory shares loss evidence even for a ${size}-product discount group`,async()=>{
 const baselines=Array.from({length:size},(_,i)=>({shopId:'900001',productId:String(300000+i)}));
 const scoped=[],individual=[];
 const p=Object.assign(Object.create(DoudianPlatform.prototype),{
  policy:{shopId:'900001'},ensure:async()=>{},
  resourceBudget:()=>({detailReaders:2,listReaders:1,overlapListReads:false,keepMonitorPages:false,interBatchDelayMs:0,idleMs:30000}),
  inventory:{listing:{campaigns:Array.from({length:500},(_,i)=>({id:String(400000+i),status:'进行中'}))}},
  scopedLossBatch:async rows=>{scoped.push(rows);return rows.map(b=>({productId:b.productId,loss:{complete:true,active:false}}));},
  loss:async b=>{individual.push(b.productId);return{complete:true,active:false};}
 });
 const result=await p.lossBatch(baselines);
 assert.equal(scoped.length,1,'small discount groups in a large store must reuse the bounded shared-read path');
 assert.deepEqual(scoped[0],baselines);assert.equal(individual.length,0);
 assert.deepEqual(result.map(r=>r.productId),baselines.map(b=>b.productId));
});

test('small inventory retains exact product reads without introducing full-store scans',async()=>{
 let reads=0,active=0,peak=0;
 const baselines=Array.from({length:5},(_,i)=>({shopId:'900001',productId:String(300000+i)}));
 const p=Object.assign(Object.create(DoudianPlatform.prototype),{
  policy:{shopId:'900001'},ensure:async()=>{},
  resourceBudget:()=>({detailReaders:2,listReaders:1,overlapListReads:false,keepMonitorPages:false,interBatchDelayMs:0,idleMs:30000}),
  inventory:{listing:{campaigns:Array.from({length:8},(_,i)=>({id:String(400000+i),status:'进行中'}))}},
  scopedLossBatch:async()=>assert.fail('small store should retain exact reads'),
  loss:async()=>{reads++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;return{complete:true,active:false};}
 });
 await p.lossBatch(baselines);assert.equal(reads,5);assert.equal(peak,2);
});
