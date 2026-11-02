import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {seedPriceQueue} from '../helpers/large-price-queue-fixture.mjs';
import {requestRecovery} from '../../src/recovery-requests.mjs';

for(const width of [1440,960])test('separate sidebar shows true price count and both-type blockers without any mutation '+width,{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-blockers-ui-')),j=new Journal(':memory:'),now=Date.now(),shopId='900001',productId='300001';
 const sku={id:'500001',name:'测试规格',baseFen:10000,discount:50,saleFen:5000};
 for(const [i,type] of ['限时抢购','限量抢购'].entries()){
  const taskId='blocked-'+i,body={title:'测试受阻任务',submitAttempts:0,reason:'PRICE_REVIEW_REQUIRED: 本方案超过平台价格限制',plans:[{shopId,productId,name:'两种方案受阻商品',type,historicalFingerprint:'history',skus:[sku]}]};
  j.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId,shopId,taskId,'blocked',JSON.stringify(body),now-100+i);
  const r={id:'review-'+i,key:'key-'+i,shopId,productId,name:'两种方案受阻商品',historicalFingerprint:'history',type,source:'live-platform-draft',taskId,status:'superseded',createdAt:now-100+i,rows:[{...sku,previousDiscount:50,previousFen:5000}]};
  j.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(r.id,shopId,productId,r.status,JSON.stringify(r),now-100+i);
 }
 seedPriceQueue(j,{pending:1,approved:0});requestRecovery(j,shopId,[{productId}],'fixture',now);
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId,name:'测试店铺'},runtime:join(dir,'server'),port:0,dependencies:{journal:j,service,browser:{close:async()=>{}},platform:{}}});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width,height:960}});
 try{
  await browser.open(shopId);const page=await browser.page(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await page.goto(app.url);await page.waitForFunction(()=>document.getElementById('price-count').textContent==='1');
  assert.equal(await page.locator('[data-view="blockers"]').count(),1);
  await page.locator('[data-view="blockers"]').click();const card=page.locator('[data-recovery-blocker="300001"]');await card.waitFor();
  await card.locator('.blocker-details > summary').click();assert.match(await card.innerText(),/限时抢购/);assert.match(await card.innerText(),/限量抢购/);assert.match(await card.innerText(),/恢复请求：queued/);
  assert.equal(await page.locator('#blocker-both-count').innerText(),'1');assert.equal(await page.locator('#price-rechecks-panel').isVisible(),false);assert.equal(await page.locator('[data-price-recheck]').count(),0,'progress is folded into the same product instead of duplicated');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts',`recovery-blockers-${width}.png`),fullPage:false});
  await page.locator('[data-view="prices"]').click();assert.equal(await page.locator('#price-rechecks-panel').isVisible(),false);assert.equal(await page.locator('#recovery-issues-panel').isVisible(),false);
  assert.equal(await page.locator('#price-count').innerText(),'1');assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
