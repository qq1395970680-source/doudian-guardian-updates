import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
test('workbench renders without script errors and starts with live actions gated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-ui-')),browser=new DedicatedBrowser(join(dir,'ui-browser'),{test:true,viewport:{width:1280,height:1000}});
 const app=await createApp({config:{shopId:'900001',name:'只读验收店铺',excludedProductIds:['300001','300002']},port:0,runtime:join(dir,'service')});
 try{await browser.open('900001');const page=await browser.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.getByText('只读验收店铺 · 900001',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'开启后台守护',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts','workbench.png'),fullPage:true});
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
