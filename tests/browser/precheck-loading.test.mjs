import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const width of [1440,960])test(`precheck waits for asynchronous SKU loading after picker closes at ${width}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-sku-loading-')),fixture=await fixtureServer({selectionLoadDelayMs:1200});
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width,height:700}}),platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{const result=await platform.precheck(fixtureProducts[0]);assert.equal(result.complete,true);assert.equal(result.skus.length,10);
  assert.equal(fixture.state.prechecks,1);assert.equal(fixture.state.creates,0);assert.equal(fixture.state.uploads,0);
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
