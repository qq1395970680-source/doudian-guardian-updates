import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for(const global of [true,false])test(`detail expansion: ${global?'global expansion replaces row controls':'individual rows without a global switch'}`,{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-v2-detail-expand-')),fixture=await fixtureServer({detailExpandable:true,detailGlobalSwitch:global}),browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{
  await browser.open('900001');browser.context.setDefaultTimeout(800);
  const detail=await platform.detail(fixture.state.campaigns[0]);
  assert.equal(detail.complete,true);assert.equal(detail.products.length,7);assert.equal(detail.products.reduce((n,p)=>n+p.skus.length,0),70);
  assert.equal(fixture.state.detailGlobalExpands||0,global?1:0);assert.equal(fixture.state.detailRowExpands||0,global?0:7);
  assert.equal(fixture.state.submits,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/detail-expansion-'+(global?'global':'individual')+'.json'),JSON.stringify({localFixtureOnly:true,complete:true,products:7,skuCount:70,globalExpands:fixture.state.detailGlobalExpands||0,rowExpands:fixture.state.detailRowExpands||0,businessSubmissions:0},null,2));
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
