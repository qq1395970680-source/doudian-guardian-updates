import test from 'node:test';
import assert from 'node:assert/strict';
import {DedicatedBrowser} from '../src/browser.mjs';
test('a stuck close surfaces a bounded error and preserves the unconfirmed browser rather than hanging login forever',async()=>{
 const browser=new DedicatedBrowser('unused-fixture-root',{test:true,closeTimeoutMs:25});let release;
 const context={close:()=>new Promise(r=>{release=r;})};browser.context=context;
 let timer;
 try{
  await assert.rejects(Promise.race([browser.close(),new Promise((_,no)=>{timer=setTimeout(()=>no(Object.assign(Error('observation ended'),{code:'OBSERVATION_TIMEOUT'})),200);})]),{code:'BROWSER_CLOSE_UNCONFIRMED'});
  assert.equal(browser.context,context,'An unconfirmed close must not pretend isolation succeeded');
  release();context.close=async()=>{};await browser.close();assert.equal(browser.context,null);
 }finally{clearTimeout(timer);release?.();}
});
