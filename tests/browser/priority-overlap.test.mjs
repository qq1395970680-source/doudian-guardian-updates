import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('native headless monitoring overlaps detail reads and drains before the next action',{timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-overlap-')),fixture=await fixtureServer({detailExpandable:true}),browser=new DedicatedBrowser(root,{test:true});
 const journal=new Journal(join(root,'tasks.sqlite')),policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true},seed=fixture.state.campaigns[0];
 fixture.state.campaigns=fixtureProducts.map((p,n)=>({...seed,id:String(4000000000000000100n+BigInt(n)),name:'当前活动'+n,status:'进行中',startAt:Date.now()-n*1000,endAt:Date.now()+86400000,products:[p]}));
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});let clockOffset=0,reads=0,reading=0,maxReading=0,monitoring=false,overlap=false,polls=0;
 const peek=platform.peekActive.bind(platform),detail=platform.detail.bind(platform);
 platform.peekActive=async()=>{polls++;monitoring=true;try{return await peek();}finally{monitoring=false;}};
 platform.detail=async c=>{const index=++reads;reading++;maxReading=Math.max(maxReading,reading);overlap=overlap||monitoring;try{return await detail(c);}finally{reading--;if(index===2)clockOffset+=31000;}};
 const service=new GuardianService({journal,platform,policy,now:()=>Date.now()+clockOffset});
 try{
  await service.tick();assert.equal(service.lastRun.ok,true,JSON.stringify(service.lastRun));assert.equal(overlap,true);assert.equal(maxReading,2);
  assert.ok(polls>=1);assert.equal(monitoring,false);assert.equal(service.priorityPoll,null);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
  assert.equal(platform.inventory.activeComplete,true);assert.equal(platform.inventory.details.size,7);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/priority-overlap-native.json'),JSON.stringify({localFixtureOnly:true,nativeHeadless:true,overlap,detailReadersMax:maxReading,polls,activeDetails:7,submits:0,uploads:0,monitorDrained:true},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});
