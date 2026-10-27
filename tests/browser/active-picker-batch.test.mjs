import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {readBatchProducts} from '../../src/recovery-batches.mjs';
import {projectBuild} from '../../src/build.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';
import {fixtureServer} from './platform-fixture.mjs';

test('one native picker read returns exactly 50 active hints without confirming selection or creating an activity',{timeout:120000},async()=>{
 const products=Array.from({length:50},(_,i)=>({productId:String(3800000000000000100n+BigInt(i)),name:'独立已参与商品'+i,
  skus:[{id:String(5800000000000000100n+BigInt(i)),name:'原规格',baseFen:10000,discount:50}]}));
 const fixture=await fixtureServer({catalogProducts:products,activePickerProducts:products.map(p=>p.productId)});
 const directory=await mkdtemp(join(tmpdir(),'guardian-active-picker-')),browser=new DedicatedBrowser(directory,{test:true});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{
  let observed;
  await assert.rejects(platform.precheckBatch(products.map(p=>({...p,shopId:'900001'}))),error=>{
   observed=error.detail?.activePicker;return error.code==='PRECHECK_ACTIVE_HINTS';
  });
  assert.equal(observed.shopId,'900001');assert.equal(observed.complete,true);assert.equal(observed.source,'live-platform-activity-picker');
  assert.deepEqual(observed.targetProductIds,products.map(p=>p.productId));assert.equal(observed.rows.length,50);
  assert.ok(observed.rows.every(r=>r.status==='active_hint'&&r.observedAt>0));assert.equal(fixture.state.prechecks,1);
  assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);assert.equal(fixture.state.cancelAttempts||0,0);
  assert.equal(fixture.state.pickerCloses,1);
  await writeFile(resolve('artifacts/beta51-active-picker-browser.json'),JSON.stringify({at:new Date().toISOString(),sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,
   requestedProducts:50,exactHintRows:50,pickerVisits:fixture.state.prechecks,submits:0,priceApprovals:0,
   hintRowsDoNotProveEffectiveActivity:true},null,2)+'\n');
 }finally{
  try{await browser.close();}finally{await fixture.close();}
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-active-picker-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

for(const changedShop of [null,'900002'])test('identity is rechecked only after closing the covering picker: changedShop='+changedShop,{timeout:120000},async()=>{
 const product={productId:'3950000000000000101',name:'遮挡身份核验商品',skus:[{id:'5950000000000000101',name:'唯一规格',baseFen:10000,discount:50}]};
 const fixture=await fixtureServer({catalogProducts:[product],activePickerProducts:[product.productId],identityNeedsHover:true,pickerCloseShopId:changedShop});
 const directory=await mkdtemp(join(tmpdir(),'guardian-active-picker-identity-')),browser=new DedicatedBrowser(directory,{test:true});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{
  let result;
  await assert.rejects(platform.precheckBatch([{...product,shopId:'900001'}]),error=>{result=error;return error.code===(changedShop?'SHOP_MISMATCH':'PRECHECK_ACTIVE_HINTS');});
  assert.equal(fixture.state.pickerCloses,1);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.cancelAttempts||0,0);
  if(changedShop)assert.equal(result.detail?.activePicker,undefined);
  else assert.equal(result.detail.activePicker.shopId,'900001');
  await writeFile(resolve('artifacts',changedShop?'beta51-active-picker-wrong-shop.json':'beta51-active-picker-overlay.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,hoverIdentityHiddenUntilRequested:true,
   pickerCoveredIdentityControl:true,pickerCloses:fixture.state.pickerCloses,identityRecheckedAfterClose:true,
   changedShop,code:result.code,submits:0,activityCancellations:0,priceApprovals:0},null,2)+'\n');
 }finally{
  try{await browser.close();}finally{await fixture.close();}
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-active-picker-identity-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

test('a mixed native picker cohort reads exact current SKU data for the selectable product without using hint rows as prices',{timeout:120000},async()=>{
 const products=Array.from({length:3},(_,i)=>({productId:String(3900000000000000100n+BigInt(i)),name:'混合预查商品'+i,
  skus:[{id:String(5900000000000000100n+BigInt(i)),name:'唯一规格',baseFen:6875,discount:95}]}));
 const fixture=await fixtureServer({catalogProducts:products,activePickerProducts:[products[0].productId,products[2].productId]});
 const directory=await mkdtemp(join(tmpdir(),'guardian-active-picker-mixed-')),browser=new DedicatedBrowser(directory,{test:true});
 const platform=new DoudianPlatform({browser,policy:{shopId:'900001'},base:fixture.base});
 try{
  const rows=await readBatchProducts(platform,products.map(p=>({baseline:{...p,shopId:'900001'}})));
  assert.equal(rows.length,3);assert.equal(rows[0].error.code,'ALREADY_ACTIVE');assert.equal(rows[2].error.code,'ALREADY_ACTIVE');
  assert.equal(rows[1].current.productId,products[1].productId);assert.equal(rows[1].current.complete,true);
  assert.deepEqual(rows[1].current.skus.map(s=>[s.id,s.name,s.baseFen]),[[null,'唯一规格',6875]]);
  const baseline={...products[1],shopId:'900001',source:'verified-platform-history',complete:true,type:'限时抢购',durationMs:172800000,
   rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30}};
  const plan=planOriginalRestore(baseline,rows[1].current,{shopId:'900001'});
  assert.deepEqual(plan.skus.map(s=>[s.id,s.observedId,s.mapping,s.saleFen]),[[products[1].skus[0].id,null,'unique-name-and-base',6532]]);
  assert.equal(fixture.state.prechecks,2);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);
  await writeFile(resolve('artifacts/beta51-active-picker-mixed-browser.json'),JSON.stringify({at:new Date().toISOString(),
   sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),localFixtureOnly:true,pickerVisits:2,independentlyReadSkuProducts:1,
   hintedProducts:2,requestedOrderPreserved:true,submits:0,priceApprovals:0,hintRowsNeverSuppliedPrices:true,
   unshownSkuIdKeptNull:true,uniqueNameAndUnchangedBaseMappedToOriginalHistory:true,plannedSaleFen:6532},null,2)+'\n');
 }finally{
  try{await browser.close();}finally{await fixture.close();}
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('guardian-active-picker-mixed-'));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
