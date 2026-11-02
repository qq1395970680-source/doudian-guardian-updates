import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {setCareRecoveryPolicy} from '../../src/care-recovery-policy.mjs';
import {setOriginalPriceRecoveryPolicy} from '../../src/original-price-recovery-policy.mjs';
import {setOriginalRebuildPolicy} from '../../src/original-rebuild-policy.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

function authorize(journal){const accounts=new AccountRegistry(journal);accounts.register({shopId:'900001'},'signin-care-native');accounts.authorizeOriginal('900001');setOriginalPriceRecoveryPolicy(journal,'900001',{enabled:true,acceptOriginalPricesOnly:true});setOriginalRebuildPolicy(journal,'900001',{enabled:true,acceptOriginalRebuild:true});setCareRecoveryPolicy(journal,'900001',{enabled:true,acceptNonReducingRecovery:true});}

for(const scenario of ['floor','mixed','unknown'])test('headless care mode automatically recovers non-reducing prices and only reads unknown after restart: '+scenario,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-care-native-')),product=fixtureProducts[0],mixed=scenario==='mixed',file=join(dir,'guardian.sqlite');
 const fixture=await fixtureServer({skuPriceFloors:{[product.skus[0].id]:6100},skuPriceCaps:mixed?{[product.skus[1].id]:5900}:{},dropAfterSubmit:scenario==='unknown'}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:960,height:600}});
 let journal=new Journal(file);authorize(journal);const policy={shopId:'900001',excludedProductIds:fixtureProducts.slice(1).map(p=>p.productId),allowMissingHistoricalSkus:true,originalRiskAllowed:true,liveEnabled:true,cutoverConfirmed:true};
 let service;const bind=()=>{service=new GuardianService({journal,platform:new DoudianPlatform({browser,policy,journal,base:fixture.base}),policy});};bind();
 try{
  await service.tick();const review=journal.priceReviews(policy.shopId)[0];assert.ok(review,JSON.stringify(journal.events(12)));
  if(mixed){assert.equal(review.status,'pending');assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);assert.equal(journal.priceTarget(policy.shopId,product.productId),null);assert.ok(fixture.state.seenPrices.every(r=>r.discount===60));}
  else{assert.equal(review.status,'approved');assert.ok(review.automaticConsent.careGrantId);assert.equal(review.consent,undefined);assert.equal(fixture.state.submits,1,JSON.stringify(journal.events(15)));assert.ok(fixture.state.seenPrices.every(r=>r.discount>=60));
   if(scenario==='unknown'){const unknown=journal.list(policy.shopId).find(t=>t.phase==='unknown');assert.ok(unknown);service.stop();await browser.close();journal.close();journal=new Journal(file);bind();await service.tick();assert.equal(journal.get(unknown.id).submitAttempts,1);}
   assert.equal(service.status().verified,1);assert.equal(fixture.state.submits,1);assert.equal(service.status().unknown,0);
  }
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','care-native-'+scenario+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,submits:fixture.state.submits,risks:fixture.state.risks,verified:service.status().verified,unknown:service.status().unknown,automaticOnlyWithoutReductions:true,originalPriceModeRetained:true},null,2));
 }finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

for(const mixed of [false,true])test('headless care mode independently reads this activity ratio and never auto-adopts a lower SKU: '+mixed,{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-care-ratio-native-')),product={productId:'300001',name:'省心倍率商品',skus:[{id:'500001',name:'小规格',baseFen:mixed?4700:10000,discount:50},{id:'500002',name:'大规格',baseFen:mixed?50300:50000,discount:50}]},other={productId:'300002',name:'有效商品',skus:[{id:'500003',name:'其他规格',baseFen:10000,discount:60}]};
 const fixture=await fixtureServer({catalogProducts:[product,other],limited:true}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true}),journal=new Journal(':memory:');authorize(journal);
 const campaign=fixture.state.campaigns[0],now=Math.floor(Date.now()/1000)*1000;Object.assign(campaign,{type:'限量抢购',status:'进行中',startAt:now,endAt:now+7*86400000,autoRenew:true,risk:true,products:[{...other,activityLimit:1000}],removals:[{productId:product.productId,name:product.name,reason:'该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。'}]});
 const policy={shopId:'900001',excludedProductIds:[other.productId],originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true};journal.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:campaign.id,type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 const service=new GuardianService({journal,platform:new DoudianPlatform({browser,policy,journal,base:fixture.base}),policy});
 try{await service.tick();const review=journal.priceReviews(policy.shopId)[0];assert.ok(review,JSON.stringify(journal.events(20)));assert.equal(review.type,'限量抢购');if(mixed){assert.equal(review.status,'pending');assert.equal(fixture.state.submits,0);assert.equal(fixture.state.uploads,0);}else{assert.equal(review.status,'approved',JSON.stringify(journal.events(20)));assert.ok(review.automaticConsent.careGrantId);assert.ok(review.rows.every(r=>r.saleFen>=r.previousFen));assert.equal(fixture.state.submits,1);assert.equal(service.status().verified,1);}await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','care-ratio-native-'+mixed+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,submits:fixture.state.submits,verified:service.status().verified,priceStatus:review.status,independentTypeEvidence:review.sourceProof?.activityType,allAutomaticRowsNonReducing:review.status==='approved'?review.rows.every(r=>r.saleFen>=r.previousFen):null},null,2));}
 finally{service.stop();await browser.close();journal.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
