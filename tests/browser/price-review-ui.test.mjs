import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

for(const width of [1440,960])test('price review shows all exact prices, needs consent and stays stable during polling '+width,{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-price-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width,height:960}});
 const service={running:true,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:'900001',name:'测试店铺'},runtime:join(dir,'server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform:{progress:{stage:'test'}}}});
 const now=Date.now(),review={id:'test-review',key:'exact-price-key',shopId:'900001',productId:'3000000000000000001',name:'净水器全套滤芯',status:'pending',createdAt:now,expiresAt:now+1800000,skippedSkuIds:[],rows:Array.from({length:56},(_,i)=>({id:String(500000+i),name:'滤芯规格 '+(i+1),baseFen:13900,previousFen:6950,previousDiscount:50,discount:i===0?48:i===1?51:50,saleFen:i===0?6672:i===1?7089:6950,evidence:i===0?['活动价不得高于近15天最低价（68元）']:i===1?['活动价不得低于近15天最低价（70元）']:[]}))};
 let available=[review],posts=[],getCount=0,connectedShop='900001';
 try{await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/status',async route=>{const r=await route.fetch(),s=await r.json();await route.fulfill({json:{...s,connection:{shopId:connectedShop},priceReviewsPending:available.filter(r=>r.status==='pending').length}});});
  await page.route(/\/api\/price-reviews\?/,route=>{getCount++;return route.fulfill({json:{shopId:'900001',reviews:available,total:available.length,page:0,pages:1,pageSize:10}});});
  await page.route('**/api/price-reviews/decide',async route=>{const body=route.request().postDataJSON();posts.push(body);available=available.map(r=>({...r,status:'approved'}));await route.fulfill({json:{ok:true,review:available[0]}});});
  await page.goto(app.url);await page.locator('[data-view="prices"]').click();await page.locator('#view-prices').waitFor({state:'visible',timeout:1800});
  await page.locator('[data-price-direction="all"]').click();
  const card=page.locator('.price-review');await card.waitFor();assert.equal(await card.locator('tbody tr').count(),25);
  assert.match(await card.innerText(),/¥66.72/);assert.match(await card.innerText(),/近15天最低价/);
  assert.match(await card.innerText(),/2 个建议调整/);assert.match(await card.innerText(),/提高 ¥1.39/);assert.match(await card.innerText(),/降低 ¥2.78/);
  assert.equal(await card.getByRole('button',{name:'暂不调整',exact:true}).count(),1);
  const approve=card.getByRole('button',{name:'确认表内价格并继续守护',exact:true}),consent=card.getByRole('checkbox');
  assert.equal(await approve.isDisabled(),true);assert.equal(await consent.isChecked(),false);assert.equal(posts.length,0);
  await consent.check();assert.equal(await approve.isEnabled(),true);
  await page.evaluate(()=>window.priceRow=document.querySelector('.price-review tbody tr'));
  const reads=getCount;await page.waitForResponse(r=>r.url().includes('/api/price-reviews?'),{timeout:7000});
  assert.ok(getCount>reads);assert.equal(await page.evaluate(()=>window.priceRow===document.querySelector('.price-review tbody tr')),true);assert.equal(await consent.isChecked(),true);
  await card.getByRole('button',{name:'下一页规格'}).click();assert.match(await card.innerText(),/滤芯规格 26/);assert.equal(await consent.isChecked(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`price-review-${width}-consent.png`),fullPage:false});
  await approve.click();await page.waitForFunction(()=>document.querySelector('.price-review')?.textContent.includes('已确认'));
  assert.equal(posts.length,1);assert.deepEqual(posts[0],{shopId:review.shopId,reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true});
  assert.equal(await card.getByRole('checkbox').count(),0);
  // The same window must not preserve consent for refreshed bounds, and a
  // disconnected or changed shop must disable an already checked proposal.
  available=[{...review,id:'new-review',key:'new-key',rows:review.rows.slice(0,2)}];
  await page.waitForResponse(r=>r.url().includes('/api/price-reviews?'),{timeout:7000});
  const next=page.locator('[data-review-id="new-review"]');await next.waitFor();assert.equal(await next.getByRole('checkbox').isChecked(),false);
  await next.getByRole('checkbox').check();connectedShop='900002';await page.waitForResponse(r=>r.url().endsWith('/api/status'),{timeout:7000});
  await page.waitForFunction(()=>document.querySelector('.price-consent input')?.disabled);assert.equal(await next.getByRole('button',{name:'确认表内价格并继续守护',exact:true}).isDisabled(),true);
  connectedShop='900001';available=[{...available[0],expiresAt:Date.now()-1}];
  await page.waitForResponse(r=>r.url().includes('/api/price-reviews?'),{timeout:7000});
  await page.getByText('建议已过期',{exact:true}).waitFor();assert.equal(await next.getByRole('checkbox').isChecked(),false);assert.equal(await next.getByRole('checkbox').isDisabled(),true);assert.equal(posts.length,1);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve('artifacts',`price-review-${width}.png`),fullPage:false});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
