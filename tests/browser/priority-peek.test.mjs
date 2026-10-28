import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';

async function setup(){
 const root=await mkdtemp(join(tmpdir(),'guardian-priority-peek-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(root,{test:true}),journal=new Journal(':memory:');
 const old=fixture.state.campaigns[0];fixture.state.campaigns.push({...structuredClone(old),id:'4000000000000000002',name:'当前活动',status:'进行中'});
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base,
  resourceBudget:()=>({detailReaders:4,listReaders:2,overlapListReads:true,keepMonitorPages:true,interBatchDelayMs:0,idleMs:10000})});
 return{fixture,browser,platform,close:async()=>{await browser.close();journal.close();await fixture.close();await rm(root,{recursive:true,force:true});}};
}

test('priority polling reuses two owned read pages and explicitly releases them before recovery',{timeout:90000},async()=>{
 const f=await setup();try{
  const first=await f.platform.peekActive(),pages=[...f.platform.monitorPages.values()];assert.equal(pages.length,2);assert.equal(first.campaigns.length,1);
  const next=await f.platform.peekActive();assert.deepEqual(next.campaigns.map(c=>c.id),first.campaigns.map(c=>c.id));
  assert.deepEqual([...f.platform.monitorPages.values()],pages);assert.equal(f.fixture.state.submits,0);assert.equal(f.fixture.state.uploads,0);
  await f.platform.closeMonitorPages();assert.equal(f.platform.monitorPages.size,0);assert.ok(pages.every(p=>p.isClosed()));
 }finally{await f.close();}
});

test('an uncleared title filter cannot turn a current monitor into a false empty inventory',{timeout:90000},async()=>{
 const f=await setup();try{
  await f.platform.peekActive();const page=f.platform.monitorPages.get('进行中');
  await page.locator('input[placeholder="请输入活动名称"]').fill('不匹配的筛选');
  await page.evaluate(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s/g,'')==='重置').onclick=()=>{};});
  await assert.rejects(f.platform.peekActive(),{code:'QUERY_CHANGED'});assert.equal(f.platform.monitorPages.size,0);
  assert.equal(f.fixture.state.submits,0);
 }finally{await f.close();}
});

test('cross-status duplicate rows close every retained monitor page and cannot prove loss',{timeout:90000},async()=>{
 const f=await setup();try{
  f.fixture.state.campaigns.push({...structuredClone(f.fixture.state.campaigns[1]),status:'未开始'});
  await assert.rejects(f.platform.peekActive(),{code:'ACTIVE_UNKNOWN'});assert.equal(f.platform.monitorPages.size,0);
  assert.ok(f.browser.context.pages().every(p=>p.url()==='about:blank'));
 }finally{await f.close();}
});
