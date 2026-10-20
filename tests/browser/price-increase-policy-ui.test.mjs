import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {activePriceIncreaseGrant} from '../../src/price-increase-policy.mjs';

test('automatic increase is visibly opt-in, changeable without restarting, and never carries a checked consent to another shop',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-price-policy-ui-')),journal=new Journal(':memory:'),browser=new DedicatedBrowser(join(dir,'ui'),{test:true,viewport:{width:960,height:960}});
 new AccountRegistry(journal).register({shopId:'900002',name:'乙店'},'signin-b');
 let starts=0;const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){},start(){starts++;}};
 const app=await createApp({config:{shopId:'900001',name:'甲店'},runtime:join(dir,'server'),port:0,dependencies:{journal,service,browser:{close:async()=>{}},
  platformFactory:policy=>({probe:async()=>({shopId:policy.shopId}),discover:async()=>({baselines:[],activeComplete:true})})}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  await fetch(app.url+'/api/finish-login',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url,'X-Guardian-Token':token},body:'{}'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.locator('[data-view="accounts"]').click();
  const consent=page.locator('#price-increase-consent'),button=page.locator('#price-increase-policy');
  await consent.waitFor({timeout:2000});assert.equal(await consent.isChecked(),false);assert.equal(await button.isDisabled(),true);
  await consent.check();assert.equal(await button.isEnabled(),true);assert.equal(activePriceIncreaseGrant(journal,'900001'),null,'checking alone is not an authorization request');
  await button.click();await page.waitForFunction(()=>document.querySelector('#price-increase-policy')?.textContent==='停止自动提价');
  assert.ok(activePriceIncreaseGrant(journal,'900001'));assert.equal(starts,0);
  await button.click();await page.waitForFunction(()=>document.querySelector('#price-increase-policy')?.textContent==='开启自动提价');
  assert.equal(activePriceIncreaseGrant(journal,'900001'),null);assert.equal(await consent.isChecked(),false);
  await consent.check();await page.getByRole('button',{name:'切换店铺',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#shop')?.textContent.includes('900002'));
  assert.equal(await consent.isChecked(),false);assert.equal(await button.isDisabled(),true);assert.equal(activePriceIncreaseGrant(journal,'900002'),null);
  await button.scrollIntoViewIfNeeded();await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts','automatic-price-increase-policy-960.png')});
  assert.deepEqual(errors,[]);assert.equal(starts,0);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
