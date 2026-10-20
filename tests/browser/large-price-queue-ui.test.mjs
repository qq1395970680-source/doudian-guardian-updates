import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {seedPriceQueue} from '../helpers/large-price-queue-fixture.mjs';

test('500 pending products paginate past 200 with ten cards and no price approval',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-large-price-ui-')),j=new Journal(':memory:');seedPriceQueue(j);
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:1440,height:960}});
 const service={running:true,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:'900001',name:'大店分页测试'},runtime:join(dir,'server'),port:0,dependencies:{journal:j,service,browser:{close:async()=>{}},platform:{progress:{stage:'test'}}}});
 try{
  await browser.open('900001');const page=await browser.page(),errors=[],writes=[],sizes=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await page.route(/\/api\/price-reviews\?/,async route=>{
   const response=await route.fetch(),body=await response.json();sizes.push(body.reviews.length);await route.fulfill({json:body});
  });
  await page.goto(app.url);await page.locator('[data-view="prices"]').click();
  await page.locator('[data-price-direction="all"]').click();
  await page.getByText('720 份记录 · 第 1 / 72 页',{exact:true}).waitFor();
  assert.equal(await page.locator('#price-count').innerText(),'500');
  for(let n=2;n<=22;n++){
   await page.locator('#price-next').click();
   await page.getByText(`720 份记录 · 第 ${n} / 72 页`,{exact:true}).waitFor();
   assert.equal(await page.locator('.price-review').count(),10);
  }
  await page.locator('[data-review-id="900001-review-289"]').waitFor();
  assert.equal(await page.locator('.price-consent input:checked').count(),0);
  assert.ok(sizes.length>=22&&sizes.every(n=>n===10));assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  assert.equal(j.priceReviewCounts('900001').pending,500);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM price_targets').get().n,0);
  await page.screenshot({path:join(import.meta.dirname,'../../artifacts/beta21-large-price-queue.png')});
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
