import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {GuardianService} from '../../src/service.mjs';
import {Journal} from '../../src/journal.mjs';
import {makeTransfer,importTransfer} from '../../src/migration.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('isolated source and destination preserve an unknown native submit and only read it back after transfer',{timeout:180000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-migration-flow-')),fixture=await fixtureServer({dropAfterSubmit:true});
 const source=new Journal(join(root,'source.sqlite')),target=new Journal(join(root,'target.sqlite')),
  sourceBrowser=new DedicatedBrowser(join(root,'source'),{test:true}),targetBrowser=new DedicatedBrowser(join(root,'destination'),{test:true,viewport:{width:960,height:600}});
 const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 const a=new GuardianService({journal:source,policy,platform:new DoudianPlatform({browser:sourceBrowser,policy,journal:source,base:fixture.base})});let b;
 try{
  await a.tick();assert.equal(a.status().unknown,1);assert.equal(fixture.state.submits,1);a.stop();await sourceBrowser.close();
  const file=makeTransfer(source,policy,{version:'2.0.0-beta.6'}),result=importTransfer(target,file,{shopId:policy.shopId,accepted:true,expectedDigest:file.digest});assert.equal(result.unknown,1);
  const destPolicy={...policy,originalRiskAllowed:false,excludedProductIds:result.excludedProductIds};
  b=new GuardianService({journal:target,policy:destPolicy,platform:new DoudianPlatform({browser:targetBrowser,policy:destPolicy,journal:target,base:fixture.base})});
  await b.tick();assert.equal(b.status().verified,1);assert.equal(b.status().unknown,0);assert.equal(fixture.state.submits,1);assert.equal(fixture.state.creates,1);
  await b.tick();assert.equal(fixture.state.submits,1);assert.equal(target.priceReviews(policy.shopId).length,0);
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/migration-headless-flow.json'),JSON.stringify({localFixtureOnly:true,physicalSecondComputer:false,separateProfilesAndDatabases:true,historyCount:target.histories(policy.shopId).length,unknownBefore:1,unknownAfter:0,submits:1,creates:1,sourceStopped:true,approvedPricesTransferred:false},null,2));
 }finally{a.stop();b?.stop();await sourceBrowser.close();await targetBrowser.close();source.close();target.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});
