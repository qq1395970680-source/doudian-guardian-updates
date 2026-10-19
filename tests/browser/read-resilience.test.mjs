import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('native headless identity timeout closes the failed page and retries the read once',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-read-retry-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(':memory:');
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  fixture.state.campaigns[0].status='进行中';fixture.state.hideShopIdForDetailLoads=1;
  const result=await platform.discover({historyReadLimit:0});
  assert.equal(result.activeComplete,true);assert.equal(fixture.state.detailLoads,2);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
  assert.equal(journal.events().filter(e=>e.kind==='detail-read-retry').length,1);assert.equal(journal.events().filter(e=>e.kind==='detail-read-recovered').length,1);
  assert.equal(browser.context.pages().filter(p=>p.url().includes('/view?')).length,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/read-resilience-headless.json'),JSON.stringify({at:new Date().toISOString(),localFixtureOnly:true,nativeHeadless:true,identityTimeoutReproduced:true,independentDetailLoads:2,activeComplete:true,submits:0,uploads:0,failedPageClosed:true},null,2));
 }finally{await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
