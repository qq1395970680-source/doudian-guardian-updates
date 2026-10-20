import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {formSlice} from '../../src/platform-snapshot.mjs';
import {Journal} from '../../src/journal.mjs';
import {makePriceReviews} from '../../src/price-review.mjs';
import {proveDraft} from '../../src/policy.mjs';
import {priceFixture,fixedNow as now} from '../helpers/price-review-fixture.mjs';

test('visible SKU error replaces sale label: read explicit current price and keep exact consent required',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-draft-evidence-')),browser=new DedicatedBrowser(root,{test:true}),journal=new Journal(':memory:');
 try{
  await browser.open('900001');const page=await browser.page(),f=priceFixture(journal),sku=f.plan.skus[0];
  for(const [markup,expected] of [
   ['<div class="ecom-mcenter-zform-error">单品活动价￥69.50，需≤￥68.00</div>',6950],
   ['<div class="ecom-mcenter-zform-error">活动价不得高于68元</div>',null],
   ['<div hidden class="ecom-mcenter-zform-error">单品活动价￥69.50，需≤￥68.00</div>',null],
   ['<div class="ecom-mcenter-zform-error">单品活动价￥69.50，需≤￥68.00</div><div class="ecom-mcenter-zform-error">单品活动价￥70，需≤￥68</div>',null],
  ]){
   await page.setContent(`<table><tr class="index-skuRow--x"><td></td><td>${sku.name} 原价：￥139</td><td><input role="spinbutton" value="5">${markup}</td></tr></table>`);
   const row=(await page.evaluate(formSlice)).cells[0].rows[0];
   assert.equal(row.saleFen,expected);
   if(expected!==null){
    const probe={...f.probe,rows:[{...f.probe.rows[0],...row,id:sku.id,productId:f.plan.productId},f.probe.rows[1]],warnings:row.errors};
    const reviews=makePriceReviews(f.task,probe,now);
    assert.equal(reviews[0].status,'pending');assert.equal(journal.priceTarget(f.plan.shopId,f.plan.productId),null);
    assert.throws(()=>proveDraft(f.task,probe,now),{code:'DRAFT_WARNING'});
   }
  }
 }finally{journal.close();await browser.close();await rm(root,{recursive:true,force:true});}
});
