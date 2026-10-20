import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {proveDraft} from '../src/policy.mjs';
import {priceFixture,fixedNow as now} from './helpers/price-review-fixture.mjs';

test('draft rejection retains exact SKU and mismatched observed values without permitting submission',()=>{
 const j=new Journal(':memory:');
 try{
  const f=priceFixture(j),probe=structuredClone(f.probe);probe.warnings=[];probe.rows[0].saleFen=null;
  assert.throws(()=>proveDraft(f.task,probe,now),error=>{
   assert.equal(error.code,'DRAFT_PRICE');
   assert.equal(error.detail.mismatches[0].productId,f.plan.productId);
   assert.equal(error.detail.mismatches[0].skuId,f.plan.skus[0].id);
   assert.deepEqual(error.detail.mismatches[0].fields,['saleFen']);
   assert.equal(error.detail.mismatches[0].expected.saleFen,6950);
   assert.equal(error.detail.mismatches[0].actual.saleFen,null);
   return true;
  });
 }finally{j.close();}
});
