import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
test('native headless inventory scans 60 current activities through six read slots and drains every boundary',{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-inventory-'));
 const products=Array.from({length:60},(_,i)=>({...fixtureProducts[0],productId:String(3000000000000000100n+BigInt(i)),name:'大店商品'+i,
  skus:fixtureProducts[0].skus.map((s,j)=>({...s,id:String(5000000000000001000n+BigInt(i*10+j))}))}));
 const fixture=await fixtureServer({catalogProducts:products,detailExpandable:true}),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'tasks.sqlite'));
 const seed=structuredClone(fixture.state.campaigns[0]);
 fixture.state.campaigns=products.map((p,i)=>({...seed,id:String(4000000000000000100n+BigInt(i)),name:'当前测试活动'+i,status:'进行中',startAt:Date.now()-i*10000,endAt:Date.now()+86400000,products:[p]}));
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 const original=platform.detail.bind(platform),sizes=[];let inFlight=0,peak=0;
 platform.detail=async c=>{peak=Math.max(peak,++inFlight);try{return await original(c);}finally{inFlight--;}};
 try{
  const started=Date.now(),observed=await platform.discover({historyReadLimit:0,onReadBoundary:async({reads})=>{assert.equal(inFlight,0);if(reads.length)sizes.push(reads.length);}});
  const elapsedMs=Date.now()-started;
  assert.equal(observed.complete,true);assert.equal(observed.activeComplete,true);assert.equal(observed.errors.length,0);assert.equal(peak,6);assert.equal(inFlight,0);
  assert.deepEqual(sizes,Array(10).fill(6));assert.equal(observed.baselines.length,60);assert.equal(fixture.state.detailLoads,60);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.creates,0);
  assert.ok(browser.context.pages().every(p=>p.url()==='about:blank'),'all read pages must have closed');
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','inventory-concurrency.json'),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,nativeHeadless:true,viewport:{width:960,height:600},peakReadPages:peak,activeComplete:true,complete:true,campaigns:60,baselines:observed.baselines.length,skuCount:600,readBatchSizes:sizes,elapsedMs,businessSubmissions:0},null,2));
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
