import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';
test('native headless inventory uses two independent read pages and closes both before returning',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-inventory-'));
 const fixture=await fixtureServer(),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'tasks.sqlite'));
 for(let i=0;i<4;i++)fixture.state.campaigns.push({...structuredClone(fixture.state.campaigns[0]),id:String(4000000000000000100n+BigInt(i)),name:'当前测试活动'+i,status:'进行中',startAt:Date.now()-i*10000,endAt:Date.now()+86400000});
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 const original=platform.detail.bind(platform);let inFlight=0,peak=0;
 platform.detail=async c=>{peak=Math.max(peak,++inFlight);try{return await original(c);}finally{inFlight--;}};
 try{
  const observed=await platform.discover();
  assert.equal(observed.complete,true);assert.equal(observed.activeComplete,true);assert.equal(observed.errors.length,0);assert.equal(peak,2);assert.equal(inFlight,0);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.creates,0);
  assert.ok(browser.context.pages().every(p=>p.url()==='about:blank'),'all read pages must have closed');
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','inventory-concurrency.json'),JSON.stringify({localFixtureOnly:true,nativeHeadless:true,viewport:{width:960,height:600},peakReadPages:peak,activeComplete:true,complete:true,campaigns:5,baselines:observed.baselines.length,businessSubmissions:0},null,2));
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
