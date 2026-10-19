import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';

test('an open workbench reconnects after managed restart without asking the user to reload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-reconnect-')),ui=new DedicatedBrowser(join(dir,'ui'),{test:true});let app;
 const dependencies=()=>({journal:new Journal(':memory:'),service:{running:false,busy:false,status:()=>({tasks:[],verified:0,unknown:0,blocked:0}),stop(){}},
  platform:{base:'https://fxg.jinritemai.com',progress:{}},browser:{async close(){},async open(){},async page(){return {goto:async()=>{}};}}});
 try{
  app=await createApp({config:{shopId:'900001'},runtime:join(dir,'service'),port:0,dependencies:dependencies()});
  const port=app.server.address().port;await ui.open('900001');const page=await ui.page();await page.goto(app.url);
  const initial=await page.locator('script[nonce]').evaluate(n=>n.nonce);
  await app.close();app=await createApp({config:{shopId:'900001'},runtime:join(dir,'service'),port,dependencies:dependencies()});
  await page.waitForFunction(old=>document.querySelector('script[nonce]')?.nonce!==old,initial,{timeout:8000});
  await page.locator('[data-view="accounts"]').click();await page.getByRole('button',{name:'登录 / 添加店铺',exact:true}).click();
  for(let i=0;i<100&&!app.snapshot().lastAction;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(app.snapshot().lastAction?.ok,true);
 }finally{await ui.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
