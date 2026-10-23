import test from 'node:test';
import assert from 'node:assert/strict';
import * as collector from '../src/collector.mjs';

const ids=Array.from({length:20},(_,i)=>String(3100000000000000000n+BigInt(i)));
const value=actual=>({products:actual.map(productId=>({productId,skus:[]})),snapshot:{counts:[20],page:1,pagerCount:1,grids:1,total:100,
 pagination:{page:1,activeCount:1,nextCount:1,nextDisabled:false,pageSize:10,total:20},countDetails:[{kind:'selected',text:'已选数量 20 个',total:20}],mode:'在线选择'},
 cells:[{top:0,height:100}],traversal:{materialAttempts:2,layoutRestarts:0,completePages:[1]}});

test('precheck membership failure reports exact target/actual/missing ids and paging without enqueue or submit',()=>{
 assert.equal(typeof collector.assertPrecheckMembership,'function');
 let failure;try{collector.assertPrecheckMembership(ids,value(ids.slice(0,10)));}catch(e){failure=e;}
 assert.equal(failure.code,'PRECHECK_MEMBERSHIP');
 const d=failure.detail.precheckMembership;
 assert.deepEqual(d.targetProductIds,ids);assert.deepEqual(d.actualProductIds,ids.slice(0,10));assert.deepEqual(d.missingProductIds,ids.slice(10));
 assert.deepEqual(d.unexpectedProductIds,[]);assert.equal(d.targetCount,20);assert.equal(d.actualCount,10);assert.deepEqual(d.snapshot.counts,[20]);
 assert.equal(d.snapshot.pagination.nextDisabled,false);assert.ok(d.failedConditions.includes('PRODUCT_COUNT'));assert.ok(d.pagingWarnings.includes('NEXT_PAGE_VISIBLE'));
 assert.match(failure.message,/目标20.*实际10/);
});
test('count-only mismatch is distinguished from missing products; equality is never relaxed',()=>{
 assert.equal(typeof collector.assertPrecheckMembership,'function');
 const v=value(ids);v.snapshot.pagination.nextDisabled=true;v.snapshot.counts=[20,19];
 assert.throws(()=>collector.assertPrecheckMembership(ids,v),e=>{
  const d=e.detail.precheckMembership;assert.deepEqual(d.missingProductIds,[]);assert.deepEqual(d.failedConditions,['COUNT_MISMATCH']);return e.code==='PRECHECK_MEMBERSHIP';
 });
 v.snapshot.counts=[20];assert.doesNotThrow(()=>collector.assertPrecheckMembership(ids,v));
 const wrong=value([...ids.slice(0,19),ids[0]]);wrong.snapshot.pagination.nextDisabled=true;
 assert.throws(()=>collector.assertPrecheckMembership(ids,wrong),e=>e.detail.precheckMembership.duplicateProductIds[0]===ids[0]);
});
