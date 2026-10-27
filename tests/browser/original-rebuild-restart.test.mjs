import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setOriginalRebuildPolicy, activeOriginalRebuildGrant} from '../../src/original-rebuild-policy.mjs';
import {projectBuild} from '../../src/build.mjs';
import {fixtureServer} from './platform-fixture.mjs';

for (const type of ['限量抢购', '限时抢购']) test(`saved original ${type} authorization survives restarts and restores two later expiries without product approval`, {timeout:360000}, async () => {
  const limited = type === '限量抢购';
  const durationMs = limited ? 28 * 86400000 + 7000 : 48 * 3600000 + 7000;
  const target = {productId:'3000000000000000121', name:'重启后原价自动守护商品', skus:[
    {id:'5000000000000000121', name:'低价规格', baseFen:6875, discount:95},
    {id:'5000000000000000122', name:'高价规格', baseFen:13000, discount:55},
  ]};
  const other = {productId:'3000000000000000120', name:'保留的有效商品', skus:[{id:'5000000000000000120', name:'原规格', baseFen:10000, discount:50}]};
  const fixture = await fixtureServer({limited, catalogProducts:[target,other], detailObservedPrices:true});
  const started = Math.floor(Date.now()/1000)*1000 - 60000;
  Object.assign(fixture.state.campaigns[0], {type, status:'进行中', autoRenew:limited, startAt:started, endAt:started+7*86400000,
    products:[{...structuredClone(other), ...(limited?{activityLimit:750}:{})}]});
  const source = {id:'4000000000000000121', name:'初始真实页面活动', type, status:'进行中', risk:false, autoRenew:limited,
    startAt:started, endAt:started+durationMs, products:[{...structuredClone(target), ...(limited?{activityLimit:888}:{})}]};
  fixture.state.campaigns.push(source);
  const directory = await mkdtemp(join(tmpdir(),'guardian-original-restart-'));
  const database = join(directory,'guardian.sqlite');
  let journal, browser, service, platform;
  const open = () => {
    journal = new Journal(database);
    const registry = new AccountRegistry(journal);
    let account = registry.selected();
    if (!account) {
      registry.register({shopId:'900001',name:'重启隔离测试店'},'shop-900001');
      account=registry.authorizeOriginal('900001');
      journal.putSettings(account.shopId,{executionEnabled:true,autoStart:true});
    }
    const saved = journal.settings(account.shopId);
    assert.equal(saved.executionEnabled,true);
    browser = new DedicatedBrowser(join(directory,'browser'),{test:true});
    const policy={...account,excludedProductIds:[other.productId],liveEnabled:saved.executionEnabled===true,cutoverConfirmed:true};
    platform = new DoudianPlatform({browser,policy,journal,base:fixture.base});
    service = new GuardianService({journal,platform,policy});
  };
  const close = async () => {
    service?.stop();
    await service?.immediatePromise?.catch(()=>{});
    await browser?.close();
    journal?.close();
    journal=null;browser=null;service=null;platform=null;
  };
  const expire = campaign => {
    const now = Math.floor(Date.now()/1000)*1000;
    Object.assign(campaign,{status:'已结束',risk:false,startAt:now-durationMs-1000,endAt:now-1000,products:[]});
  };
  try {
    open();
    await service.tick();
    assert.equal(service.lastRun.ok,true,service.lastRun.message);
    const captured=service.latestHistories().get(target.productId);
    assert.equal(captured.type,type);
    assert.equal(captured.durationMs,durationMs);
    if(limited)assert.equal(captured.activityLimit,888);
    assert.equal(fixture.state.submits,0);
    const originalGrant=setOriginalRebuildPolicy(journal,'900001',{enabled:true,acceptOriginalRebuild:true});
    await close();

    expire(source);
    const receipts=[];
    for (let restart=1;restart<=2;restart++) {
      open();
      const persistedGrant=activeOriginalRebuildGrant(journal,'900001');
      assert.equal(persistedGrant.id,originalGrant.id);
      assert.equal(persistedGrant.key,originalGrant.key);
      await service.tick();
      assert.equal(service.lastRun.ok,true,JSON.stringify({run:service.lastRun,checks:journal.productChecks('900001')}));
      const verified=journal.list('900001').filter(t=>t.phase==='verified');
      assert.equal(verified.length,restart,JSON.stringify({tasks:journal.list('900001'),checks:journal.productChecks('900001')}));
      const latest=verified.sort((a,b)=>b.receipt.verifiedAt-a.receipt.verifiedAt)[0];
      assert.equal(latest.plans.length,1);
      assert.equal(latest.plans[0].productId,target.productId);
      assert.equal(latest.plans[0].type,type);
      assert.equal(latest.receipt.durationMs,durationMs);
      assert.equal(latest.receipt.skuCount,2);
      assert.equal(latest.lossEvidence.complete,true);
      if(limited)assert.equal(latest.lossEvidence.continuities[0].kind,'authorized-original-rebuild');
      assert.equal(journal.priceReviews('900001').filter(r=>r.status==='pending'||r.status==='approved').length,0);
      const created=fixture.state.campaigns.find(c=>c.id===latest.receipt.campaignId);
      const independent=await platform.detail(created);
      assert.equal(independent.complete,true);
      assert.deepEqual(independent.products[0].skus.map(s=>[s.id,s.baseFen,s.discount,s.saleFen,s.saleSource]),[
        [target.skus[0].id,6875,95,6532,'observed'],[target.skus[1].id,13000,55,7150,'observed'],
      ]);
      if(limited){assert.equal(latest.receipt.productLimits[0].activityLimit,888);assert.equal(latest.receipt.autoRenew,true);}
      receipts.push({campaignId:latest.receipt.campaignId,verifiedAt:latest.receipt.verifiedAt,skuCount:latest.receipt.skuCount,durationMs:latest.receipt.durationMs});
      assert.equal(fixture.state.submits,restart);
      await service.tick();
      assert.equal(fixture.state.submits,restart,'later patrol cannot duplicate the verified submission');
      assert.equal(fixture.state.campaigns[0].status,'进行中');
      assert.equal(fixture.state.cancelAttempts||0,0);
      await close();
      if(restart===1)expire(created);
    }
    const report={at:new Date().toISOString(),sourceBuild:await projectBuild(resolve(import.meta.dirname,'../..')),
      localFixtureOnly:true,physicalOtherAccount:false,type,durationMs,isolatedFreshDataDirectory:true,
      sqliteReopenedBeforeEachExpiry:true,consentCalls:1,consentSurvivedRestarts:true,perProductPriceApprovals:0,
      receipts,submits:fixture.state.submits,exactIndependentReadback:true,laterPatrolNoDuplicate:true,validOtherActivityPreserved:true};
    await writeFile(resolve('artifacts',limited?'original-rebuild-restart-limited.json':'original-rebuild-restart-timed.json'),JSON.stringify(report,null,2)+'\n');
  } finally {
    if(journal)await close();
    await fixture.close();
    await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
