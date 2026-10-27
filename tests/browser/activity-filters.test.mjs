import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('routine inventory uses both current-status filters and title readback uses its native query',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-active-filter-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(root,{test:true}),journal=new Journal(':memory:');
 const ended=fixture.state.campaigns[0];
 fixture.state.campaigns.push({...structuredClone(ended),id:'4000000000000000002',name:'进行中的活动',status:'进行中',startAt:Date.now()-60000,endAt:Date.now()+86400000},
  {...structuredClone(ended),id:'4000000000000000003',name:'将来的活动',status:'未开始',startAt:Date.now()+60000,endAt:Date.now()+86400000});
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  const inventory=await platform.discover({historyReadLimit:0});assert.equal(inventory.activeComplete,true);
  assert.deepEqual(platform.inventory.listing.campaigns.map(c=>c.status).sort(),['未开始','进行中'].sort());
  const selected=await platform.list({title:'进行中的活动'});assert.equal(selected.campaigns.length,1);assert.equal(selected.campaigns[0].id,'4000000000000000002');
  const none=await platform.list({title:'不存在的任务'});assert.equal(none.complete,true);assert.equal(none.campaigns.length,0);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.ok(browser.context.pages().every(p=>p.url()==='about:blank'));
 }finally{await browser.close();journal.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});

test('an incomplete list row retains page and field diagnostics without accepting a partial inventory',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-list-row-proof-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(root,{test:true}),journal=new Journal(':memory:');
 fixture.state.campaigns[0].status='未知状态';
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  await assert.rejects(platform.list(),error=>error.code==='LIST_INCOMPLETE'&&/第1页第1行/.test(error.message)&&/列数9/.test(error.message)&&/状态缺失/.test(error.message));
  assert.equal(platform.inventory,null);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
 }finally{await browser.close();journal.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});
