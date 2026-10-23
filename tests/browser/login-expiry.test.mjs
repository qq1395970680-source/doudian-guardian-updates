import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('detail wait detects visible expired login on the unchanged marketing URL and closes its page',{timeout:30000},async()=>{
 const fixture=await fixtureServer(),dir=await mkdtemp(join(tmpdir(),'guardian-login-expiry-')),browser=new DedicatedBrowser(dir,{test:true});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{
  await browser.open('900001');
  await browser.context.route('**/view?*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><div class="index_userName__x" title="独立测试店铺">独立测试店铺</div><div label="店铺ID" value="900001"><span class="index_descValueText__x">900001</span></div><p>加载中</p><script>setTimeout(()=>{document.body.innerHTML='<p>手机登录 邮箱登录</p><input placeholder="请输入手机号"><input placeholder="请输入验证码"><button>登录</button>';},1000);</script>`}));
  const start=Date.now();await assert.rejects(platform.detail(fixture.state.campaigns[0]),{code:'LOGIN_REQUIRED'});
  assert.ok(Date.now()-start<8000);assert.equal(browser.context.pages().filter(p=>p.url().includes('/view?')).length,0);
  assert.equal(platform.readHealth().last.code,'LOGIN_REQUIRED');assert.equal(fixture.state.submits,0);
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
