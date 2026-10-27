import test from 'node:test';
import assert from 'node:assert/strict';
import {readBatchProducts} from '../src/recovery-batches.mjs';

const members=n=>Array.from({length:n},(_,i)=>({baseline:{shopId:'900001',productId:String(300001+i),skus:[{id:String(500001+i)}]}}));
const observation=(items,statuses=items.map(()=> 'active_hint'))=>({source:'live-platform-activity-picker',shopId:'900001',complete:true,
 targetProductIds:items.map(m=>m.baseline.productId),observedAt:Date.now(),
 rows:items.map((m,i)=>({productId:m.baseline.productId,status:statuses[i],observedAt:Date.now(),page:1}))});
const signal=data=>Object.assign(Error('Complete picker cohort contains active hints'),{code:'PRECHECK_ACTIVE_HINTS',detail:{activePicker:data}});

test('50 already-active picker hints avoid recursive selection and remain hints requiring independent activity proof',async()=>{
 const items=members(50);let batches=0,singles=0;
 const platform={precheckBatch:async()=>{batches++;throw signal(observation(items));},precheck:async()=>{singles++;assert.fail('Active hints must not reopen selection per product');}};
 const rows=await readBatchProducts(platform,items);
 assert.equal(batches,1);assert.equal(singles,0);assert.equal(rows.length,50);
 assert.deepEqual(rows.map(r=>r.member.baseline.productId),items.map(m=>m.baseline.productId));
 assert.ok(rows.every(r=>r.error?.code==='ALREADY_ACTIVE'&&!r.current&&!r.loss));
});

test('a mixed picker cohort independently prechecks only selectable products and preserves requested order',async()=>{
 const items=members(3);let batches=0;const singles=[];
 const current={shopId:'900001',productId:items[1].baseline.productId,complete:true,observedAt:Date.now(),skus:[{id:'500002',baseFen:10000,discount:50}]};
 const platform={precheckBatch:async()=>{batches++;throw signal(observation(items,['active_hint','selectable','active_hint']));},
  precheck:async b=>{singles.push(b.productId);return current;}};
 const rows=await readBatchProducts(platform,items);
 assert.equal(batches,1);assert.deepEqual(singles,[items[1].baseline.productId]);
 assert.equal(rows[0].error.code,'ALREADY_ACTIVE');assert.deepEqual(rows[1].current,current);assert.equal(rows[2].error.code,'ALREADY_ACTIVE');
});

for(const mode of ['wrong-shop','missing-row','duplicate-row','extra-row','wrong-targets','stale','future','unsupported-status','no-active-hints'])
test('incomplete or inconsistent picker hints fail the whole scope without extra reads: '+mode,async()=>{
 const items=members(3),data=observation(items);let extra=0;
 if(mode==='wrong-shop')data.shopId='900002';
 if(mode==='missing-row')data.rows.pop();
 if(mode==='duplicate-row')data.rows[2]=structuredClone(data.rows[0]);
 if(mode==='extra-row')data.rows.push({...data.rows[0],productId:'399999'});
 if(mode==='wrong-targets')data.targetProductIds[0]='399999';
 if(mode==='stale')data.rows[0].observedAt=Date.now()-180000;
 if(mode==='future')data.observedAt=Date.now()+10000;
 if(mode==='unsupported-status')data.rows[0].status='ignore-price-check';
 if(mode==='no-active-hints')data.rows.forEach(r=>r.status='selectable');
 const platform={precheckBatch:async()=>{throw signal(data);},precheck:async()=>{extra++;assert.fail('Malformed scope cannot schedule a product read');}};
 const rows=await readBatchProducts(platform,items);assert.equal(extra,0);assert.equal(rows.length,3);
 assert.ok(rows.every(r=>r.error?.code==='PRECHECK_MEMBERSHIP'&&!r.current));
});
