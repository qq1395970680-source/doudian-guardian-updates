import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('platform main submit label 提交 uses the exact verified draft and independent readback',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-submit-label-')),fixture=await fixtureServer({submitLabel:'提 交'}),browser=new DedicatedBrowser(dir,{test:true});
 const journal=new Journal(':memory:'),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{await service.tick();assert.equal(service.status().verified,1,JSON.stringify(service.status()));assert.equal(fixture.state.creates,1);assert.equal(fixture.state.submits,1);assert.equal(journal.list('900001')[0].submitAttempts,1);}
 finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('ambiguous main submit controls stop before recording a submit attempt',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-submit-ambiguity-')),fixture=await fixtureServer({submitLabel:'提交',extraSubmitButton:true}),browser=new DedicatedBrowser(dir,{test:true});
 const journal=new Journal(':memory:'),policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const platform=new DoudianPlatform({browser,policy,journal,base:fixture.base}),service=new GuardianService({platform,policy,journal});
 try{await service.tick();assert.equal(service.status().blocked,1);assert.equal(service.status().unknown,0);assert.equal(fixture.state.creates,0);assert.equal(journal.list('900001')[0].submitAttempts,0);}
 finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
