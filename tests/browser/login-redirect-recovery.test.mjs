import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('native headless silent-login redirect returns to the same account without pausing or merchant writes',{timeout:30000},async()=>{
 const fixture=await fixtureServer(),dir=await mkdtemp(join(tmpdir(),'guardian-transient-login-')),browser=new DedicatedBrowser(dir,{test:true});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});let required=0;
 platform.onAuthenticationFailure=()=>required++;
 try{
  await browser.open('900001');
  await browser.context.route('**/view?*',async route=>{
   const u=new URL(route.request().url());if(u.searchParams.get('fixture-restored')==='1')return route.continue();
   u.searchParams.set('fixture-restored','1');
   await route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><meta charset="utf-8"><p>手机登录 邮箱登录</p><input placeholder="请输入手机号"><input placeholder="请输入验证码"><button>登录</button><script>setTimeout(()=>location.replace('+JSON.stringify(u.href)+'),900);</script>'});
  });
  const detail=await platform.detail(fixture.state.campaigns[0]);
  assert.equal(detail.complete,true);assert.equal(required,0);assert.equal(platform.readHealth().last.ok,true);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.creates,0);
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
