import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {createApp} from '../src/server.mjs';
import {recoveryTask,seedRecoveries} from './helpers/recovery-fixture.mjs';

test('recovery history separates independent receipts from unknown and blocked attempts and isolates shops',async()=>{
 const {buildRecoveryHistory}=await import('../src/recovery-history.mjs');
 const tasks=[recoveryTask(0),recoveryTask(21),recoveryTask(2,{phase:'unknown'}),recoveryTask(3,{phase:'blocked'}),recoveryTask(4,{shopId:'900002'})];
 const broken=recoveryTask(5);broken.receipt.skuCount=1;tasks.push(broken);
 const result=buildRecoveryHistory({shopId:'900001',tasks});
 assert.equal(result.total,2);assert.deepEqual(result.counts,{restoredProducts:1,restoredOccurrences:2,verifiedSkus:4,pendingOccurrences:2,blockedOccurrences:1});
 assert.equal(result.records.length,2);assert.ok(result.records.every(r=>r.state==='verified'&&r.currentValidity==='historical-receipt'));
 assert.equal(result.records[0].skus[0].saleFen,5000);assert.equal(result.records[0].skus[0].historicalSaleFen,5000);
 assert.equal(buildRecoveryHistory({shopId:'900001',tasks,filter:'pending'}).total,2);
 assert.equal(buildRecoveryHistory({shopId:null,tasks}).total,0);
});
test('pagination is bounded and search spans product, SKU and campaign; exact automatic higher targets are identified',async()=>{
 const {buildRecoveryHistory}=await import('../src/recovery-history.mjs');
 const tasks=Array.from({length:27},(_,i)=>recoveryTask(i)),t=tasks[0],p=t.plans[0];
 p.priceApprovalId='review1';p.skus[0]={...p.skus[0],originalDiscount:50,discount:60,saleFen:6000};p.skippedSkuIds=['699999'];
 const reviews=[{id:'review1',shopId:t.shopId,productId:p.productId,approvalKind:'automatic-price-increase'}];
 const result=buildRecoveryHistory({shopId:'900001',tasks,reviews,query:'700000'});
 assert.equal(result.total,1);assert.equal(result.records[0].mode,'automatic-price-increase');assert.equal(result.records[0].skus[0].historicalSaleFen,5000);
 assert.equal(result.records[0].skippedSkuCount,1);
 assert.equal(buildRecoveryHistory({shopId:'900001',tasks,query:'滤芯规格 2'}).total,27);
 const page=buildRecoveryHistory({shopId:'900001',tasks,page:2,pageSize:10});assert.equal(page.records.length,7);assert.equal(page.page,2);
 assert.equal(buildRecoveryHistory({shopId:'900001',tasks,page:-5,pageSize:999}).records.length,20);
 assert.equal(buildRecoveryHistory({shopId:'900001',tasks,page:999,pageSize:10}).page,2);
 assert.equal(buildRecoveryHistory({shopId:'900001',tasks}).revision,buildRecoveryHistory({shopId:'900001',tasks}).revision);
});
test('read-only recovery endpoint serves selected shop, receipts and safely bounded pages without changing journal',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-recovery-api-')),journal=new Journal(':memory:');
 seedRecoveries(journal,[recoveryTask(),recoveryTask(1,{shopId:'900002'})]);
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal,browser:{close:async()=>{}},service:{running:false,busy:false,status:()=>({tasks:[]}),stop(){}},platform:{}}});
 try{const before=journal.list('900001'),response=await fetch(app.url+'/api/recoveries?shopId=900002');assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.shopId,'900001');assert.equal(result.total,1);assert.equal(result.records[0].productId,'300000');
  assert.deepEqual(journal.list('900001'),before);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
