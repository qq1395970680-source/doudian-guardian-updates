import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecheckProgress} from '../src/recheck-progress.mjs';
import {recoveryTask} from './helpers/recovery-fixture.mjs';
test('a post-request independent receipt finishes the progress row even before queue housekeeping',()=>{
 const task=recoveryTask(),productId=task.plans[0].productId,at=task.receipt.verifiedAt;
 const queue={items:[{id:'request',productId,state:'pending',requestedAt:at-100,updatedAt:at-50}]};
 const result=buildRecheckProgress({shopId:task.shopId,queue,tasks:[task],products:[{productId,name:'正确商品名称'}]});
 assert.equal(result.pending,0);assert.equal(result.records[0].state,'verified');assert.equal(result.records[0].name,'正确商品名称');
 assert.equal(queue.items[0].state,'pending');
 const active={...structuredClone(task),id:'new-unknown',phase:'unknown'};
 assert.equal(buildRecheckProgress({shopId:task.shopId,queue,tasks:[task,active]}).records[0].state,'verifying');
});
