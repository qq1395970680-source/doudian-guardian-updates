import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {GuardError} from '../../src/policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';
import {installDateTimeFixture} from './date-time-fixture.mjs';

for(const type of ['限量抢购','限时抢购'])test(`persistent blocked task rechecks and restores exact duration through patrol: ${type}`,{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-duration-retry-')),file=join(dir,'tasks.sqlite');
 const fixture=await fixtureServer({limited:type==='限量抢购'}),policy={shopId:'900001',originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let browser=new DedicatedBrowser(dir,{test:true}),journal=new Journal(file),service;
 let failOld=true,clock=Date.now()-16*60000,lossReads=0,prechecks=0;
 const baseline={...structuredClone(fixtureProducts[0]),source:'verified-platform-history',complete:true,shopId:policy.shopId,type,durationMs:2419207000,activityLimit:1000,campaignId:'4000000000000000001',
  rules:{noLimit:type!=='限量抢购',noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(type==='限量抢购'?{autoRenew:true}:{})}};
 const create=()=>{
  const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base});
  // Discovery/loss are controlled fixture evidence. SKU precheck, draft,
  // submit, risk prompt and independent receipt all use the browser adapter.
  const facade={discover:async()=>({baselines:[baseline],activeComplete:true}),
   loss:async()=>{lossReads++;return {complete:true,active:fixture.state.submits>0,observedAt:clock,lossKey:'fixture-explicit-removal'};},
   precheck:async b=>{prechecks++;return {...await platform.precheck(b),observedAt:clock};},
   prepare:async t=>{if(failOld)throw new GuardError('DRAFT_TIME_READONLY','beta.26 whole-day guard');return platform.prepare(t);},
   submit:platform.submit.bind(platform),readback:platform.readback.bind(platform),release:platform.release.bind(platform)};
  platform.setDates=async(page,plan)=>{
   await page.evaluate(installDateTimeFixture,{start:Math.floor(Date.now()/1000)*1000,duration:plan.durationMs});
   // Fixture's onchange handler owns its server-facing form state.
   await page.evaluate(()=>{window.commitExactDates=()=>document.querySelector('input[placeholder="开始日期"]').onchange();document.querySelector('.ecom-mcenter-picker-dropdown button').addEventListener('click',window.commitExactDates);});
   await DoudianPlatform.prototype.setDates.call(platform,page,plan);
  };
  const instance=new GuardianService({journal,platform:facade,policy,now:()=>failOld?clock:Date.now()});
  platform.assertWrite=facade.assertWrite;return instance;
 };
 try{
  service=create();await service.tick();const blocked=journal.list(policy.shopId)[0];
  assert.equal(blocked.phase,'blocked');assert.match(blocked.reason,/DRAFT_TIME_READONLY/);assert.equal(blocked.submitAttempts,0);assert.equal(fixture.state.submits,0);
  const previousReads=prechecks;service.stop();await browser.close();journal.close();
  journal=new Journal(file);assert.equal(journal.get(blocked.id).phase,'blocked');
  browser=new DedicatedBrowser(dir,{test:true});failOld=false;clock=Date.now();service=create();
  await service.tick();const actual=journal.get(blocked.id);
  assert.equal(actual.phase,'verified',JSON.stringify({actual,run:service.lastRun}));assert.equal(journal.list(policy.shopId).length,1);
  assert.ok(prechecks>previousReads);assert.ok(lossReads>=4);assert.equal(actual.submitAttempts,1);assert.equal(actual.receipt.durationMs,2419207000);
  const campaign=fixture.state.campaigns.at(-1);assert.equal(campaign.endAt-campaign.startAt,2419207000);
  assert.equal(actual.receipt.startAt,actual.draftProof.observation.startAt);assert.equal(actual.receipt.endAt,actual.draftProof.observation.endAt);
  assert.deepEqual(campaign.products[0].skus,fixtureProducts[0].skus);
  await service.tick();assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);
 }finally{service?.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
