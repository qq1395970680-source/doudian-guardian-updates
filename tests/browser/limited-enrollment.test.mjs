import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {fixtureServer} from './platform-fixture.mjs';
test('new account learns actual limited activity and restores a risk removal without replenishing sold-out stock',{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-limited-enroll-')),fixture=await fixtureServer({limited:true,hideDetailRenewal:true});
 const c=fixture.state.campaigns[0];Object.assign(c,{type:'限量抢购',status:'进行中',autoRenew:true,startAt:Math.floor(Date.now()/1000)*1000-60000});c.endAt=c.startAt+7*86400000;
 c.products=c.products.slice(0,1);c.products[0].activityLimit=750;c.products[0].skus.forEach(s=>s.discount=55);
 const browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(join(dir,'tasks.sqlite'));
 const policy={shopId:'900001',captureExistingOnly:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({journal,platform,policy});
 try{
  await service.tick();assert.equal(service.lastRun.ok,true,service.lastRun.message);
  const b=service.latestHistories().get(c.products[0].productId);assert.equal(b.type,'限量抢购');assert.equal(b.activityLimit,750);assert.equal(b.rules.autoRenew,true);
  assert.equal(fixture.state.submits,0);
  Object.assign(c.products[0],{removalConfirmed:true,removalRiskConfirmed:true});c.risk=true;
  await service.tick();
  const task=journal.list('900001')[0];assert.equal(task?.phase,'verified',JSON.stringify(service.status()));
  assert.equal(task.plans[0].activityLimit,750);assert.equal(task.plans[0].skus[0].discount,55);assert.equal(fixture.state.submits,1);
  Object.assign(fixture.state.campaigns.at(-1).products[0],{removalConfirmed:true,soldOut:true});
  await service.tick();assert.equal(fixture.state.submits,1,'sold-out quota must not be recreated as a risk removal');
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
