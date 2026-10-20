import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {createApp} from '../../src/server.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {ratioFixture} from '../helpers/ratio-review-fixture.mjs';

for(const width of [960,1440])test('ratio UI exposes all prices and reductions and records only explicit exact consent '+width,{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-ratio-ui-')),j=new Journal(':memory:');
 const now=Date.now(),f=ratioFixture(j,{now,mixed:true}),r=j.recordRemovalPriceReview(f.plan,f.loss,now);
 const platform={progress:{stage:'test'},probe:async()=>({shopId:f.policy.shopId,name:'倍率测试店铺'})};
 const service=new GuardianService({journal:j,platform,policy:f.policy});
 const browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width,height:900}});
 const app=await createApp({config:f.policy,runtime:join(dir,'server'),port:0,
  dependencies:{journal:j,service,platform,browser:{close:async()=>{}}}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  for(let i=0;i<50&&!app.snapshot().connection;i++)await new Promise(resolve=>setTimeout(resolve,10));
  await browser.open(f.policy.shopId);const page=await browser.page(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('[data-view="prices"]').click();
  await page.locator('[data-price-direction="all"]').click();
  const card=page.locator('.price-review');await card.waitFor();
  assert.equal(await card.getByRole('checkbox').count(),0);
  await card.locator('[data-price-option="original"]').click();
  assert.match(await card.innerText(),/最高规格价不超过最低价的 3.5 倍/);
  assert.match(await card.innerText(),/1 个规格降价/);
  assert.match(await card.innerText(),/倍率推算不属于自动提价授权/);
  assert.match(await card.innerText(),/¥155.93/);
  assert.equal(await card.locator('tbody tr').count(),2);
  const approve=card.getByRole('button',{name:'确认表内价格并继续守护',exact:true});
  assert.equal(await approve.isDisabled(),true);assert.equal(j.priceTarget(r.shopId,r.productId),null);
  await card.getByRole('checkbox').check();
  assert.equal(await approve.isEnabled(),true);
  await mkdir(resolve('artifacts'),{recursive:true});
  await page.screenshot({path:resolve('artifacts',`ratio-review-${width}.png`),fullPage:false,animations:'disabled'});
  if(width===1440){
   await card.locator('[data-price-option="switch-original"]').click();
   assert.equal(await card.getByRole('checkbox').isChecked(),false);
   assert.match(await card.innerText(),/限时抢购/);
   assert.match(await card.innerText(),/48小时/);
   await card.getByRole('checkbox').check();
  }
  await approve.click();await page.getByText('已确认',{exact:true}).waitFor();
  assert.deepEqual(j.priceTarget(r.shopId,r.productId).rows.map(s=>s.discount),width===1440?[50,50]:[95,31]);
  if(width===1440)assert.equal(j.priceTarget(r.shopId,r.productId).campaignTarget.type,'限时抢购');
  assert.equal(j.list(r.shopId).length,0,'recording consent is not a direct platform submit');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
