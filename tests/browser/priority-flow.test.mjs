import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {PriorityWatch} from '../../src/priority-watch.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

for(const viewport of [{width:1440,height:960},{width:960,height:600}])test('priority restore completes 5 products and 50 SKUs before unrelated detail pages at '+viewport.width,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-priority-flow-')),fixture=await fixtureServer(),browser=new DedicatedBrowser(dir,{test:true,viewport});
 const journal=new Journal(join(dir,'tasks.sqlite')),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(5).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{
  fixture.state.campaigns[0].status='进行中';
  const discovery=await platform.discover({historyReadLimit:0});for(const baseline of discovery.baselines)journal.remember(baseline);
  const original=platform.inventory.listing.campaigns[0],watch=new PriorityWatch(journal,policy.shopId);watch.observe(original,platform.inventory.details.get(original.id));
  // Cancellation is simulated only in this isolated local platform fixture.
  fixture.state.campaigns[0].status='已失效';
  const unrelated={...structuredClone(fixture.state.campaigns[0]),id:'4000000000000000009',name:'无关当前活动',status:'进行中',products:fixtureProducts.slice(5)};
  fixture.state.campaigns.push(unrelated);
  const readIds=[],read=platform.detail.bind(platform);platform.detail=async c=>{readIds.push(c.id);return await read(c);};
  const started=Date.now();await service.tick();
  assert.equal(service.status().verified,5,JSON.stringify({status:service.status(),events:journal.events(10)}));
  assert.equal(service.priorityResume,true);assert.equal(service.lastRun,null);assert.ok(!readIds.includes(unrelated.id));
  const task=journal.list(policy.shopId)[0];assert.equal(task.receipt.skuCount,50);assert.equal(task.submitAttempts,1);assert.equal(task.riskAttempts,1);
  assert.equal(fixture.state.submits,1);assert.equal(fixture.state.uploads,1);assert.equal(platform.monitorPages.size,0);
  const recoveryMs=Date.now()-started;await service.tick();assert.equal(fixture.state.submits,1);assert.equal(service.status().unknown,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts',`priority-flow-${viewport.width}.json`),JSON.stringify({localFixtureOnly:true,viewport,priorityBeforeUnrelatedDetails:true,recoveryMs,products:5,skus:50,submits:fixture.state.submits,task},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
