import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('one precheck page selects 50 of 500 products and reads all 500 target SKUs without price writes',{timeout:180000},async()=>{
 const products=Array.from({length:500},(_,i)=>({productId:String(3000000000000000000n+BigInt(i)),name:'批量商品'+i,
  skus:Array.from({length:10},(_,j)=>({id:String(5000000000000000000n+BigInt(i*10+j)),name:'规格'+j,baseFen:10000+i*10+j,discount:60}))}));
 const fixture=await fixtureServer({catalogProducts:products}),dir=await mkdtemp(join(tmpdir(),'guardian-batch-precheck-'));
 const browser=new DedicatedBrowser(dir,{test:true,viewport:{width:960,height:600}}),journal=new Journal(join(dir,'tasks.sqlite'));
 const platform=new DoudianPlatform({browser,journal,policy:{shopId:'900001'},base:fixture.base});
 try{
  const targets=products.slice(400,450).map(p=>({...p,shopId:'900001'})),started=Date.now();
  const current=await platform.precheckBatch(targets);
  assert.equal(fixture.state.prechecks,1);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.submits,0);
  assert.equal(current.length,50);assert.deepEqual(current.map(p=>p.productId),targets.map(p=>p.productId));
  assert.equal(current.reduce((n,p)=>n+p.skus.length,0),500);
  for(let i=0;i<targets.length;i++){
   assert.equal(current[i].complete,true);assert.equal(current[i].shopId,'900001');
   assert.deepEqual(current[i].skus.map(s=>[s.name,s.baseFen]),targets[i].skus.map(s=>[s.name,s.baseFen]));
  }
  await writeFile(resolve('artifacts/batch-precheck-500-catalog.json'),JSON.stringify({
   at:new Date().toISOString(),localFixtureOnly:true,catalogProducts:500,targetProducts:50,targetSkus:500,
   precheckPages:fixture.state.prechecks,uploads:fixture.state.uploads,submits:fixture.state.submits,
   elapsedMs:Date.now()-started,viewport:{width:960,height:600}
  },null,2)+'\n');
 }finally{
  await browser.close();journal.close();await fixture.close();
  assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());
  assert.ok(basename(dir).startsWith('guardian-batch-precheck-'));
  await rm(dir,{recursive:true,force:true});
 }
});
