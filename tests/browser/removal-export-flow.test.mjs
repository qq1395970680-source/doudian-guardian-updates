import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
import {checkRemovalPrices} from '../../src/removal-export.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';

for(const corrupt of [false,true])test('direct platform removal download is scoped, read-only and fail-closed: '+corrupt,{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-removal-')),fixture=await fixtureServer({limited:true});
 const browser=new DedicatedBrowser(dir,{test:true}),policy={shopId:'900001',liveEnabled:true,cutoverConfirmed:true,originalRiskAllowed:true};
 const platform=new DoudianPlatform({browser,policy,base:fixture.base}),raw=fixture.state.campaigns[0],removed=fixtureProducts[0];
 raw.type='限量抢购';raw.autoRenew=true;raw.status='进行中';raw.startAt=Math.floor(Date.now()/1000)*1000;
 raw.endAt=raw.startAt+7*86400000;raw.risk=true;raw.products=fixtureProducts.slice(1).map(p=>({...p,activityLimit:1000}));
 raw.removals=[{productId:removed.productId,name:removed.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}];
 raw.corruptRemoval=corrupt;
 try{
  const listing=await platform.listActive(),campaign=listing.campaigns[0],detail=await platform.detail(campaign);
  assert.equal(detail.complete,true);assert.equal(fixture.state.removalDownloads,1);
  const baseline={source:'verified-platform-history',complete:true,shopId:policy.shopId,...removed,campaignId:campaign.id,
   type:'限量抢购',rules:detail.rules,durationMs:7*86400000,activityLimit:1000};
  if(corrupt){
   assert.ok(detail.removalExportError);assert.equal(detail.removalExport,undefined);
   assert.throws(()=>platform.lossFrom(baseline,listing,new Map([[campaign.id,detail]]),true),{code:'LIMITED_LOSS_UNPROVEN'});
  }else{
   assert.equal(detail.removalExport.source,'live-platform-removal-export');
   assert.equal(detail.removalExport.shopId,policy.shopId);assert.equal(detail.removalExport.campaignId,campaign.id);
   const loss=platform.lossFrom(baseline,listing,new Map([[campaign.id,detail]]),true);
   assert.equal(loss.active,false);assert.equal(loss.removal.productId,removed.productId);
   // The live product search no longer includes an activity after it removed
   // this product. Follow the exact previous activity via a fresh list read.
   const freshLoss=await platform.loss(baseline,{fresh:true});
   assert.equal(freshLoss.active,false);assert.equal(freshLoss.removal.productId,removed.productId);
   const plan=planOriginalRestore(baseline,{...baseline,observedAt:Date.now()},policy);
   assert.doesNotThrow(()=>checkRemovalPrices(plan,loss.removal));
   for(const changed of [{shopId:'900002'},{campaignId:'400009'},{records:[]}]) {
    const bad={...detail,removalExport:{...detail.removalExport,...changed}};
    assert.throws(()=>platform.lossFrom(baseline,listing,new Map([[campaign.id,bad]]),true),{code:'LIMITED_LOSS_UNPROVEN'});
   }
  }
  assert.equal(fixture.state.creates,0);assert.equal(fixture.state.submits,0);assert.equal(fixture.state.risks,0);
  assert.equal(fixture.state.cancelAttempts,undefined);
 }finally{await browser.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
