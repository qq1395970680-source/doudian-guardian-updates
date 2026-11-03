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
import {setDualActivityCarePolicy,getDualActivityDecision,validDualActivityApproval} from '../../src/dual-activity-recovery.mjs';
import {fixtureServer} from './platform-fixture.mjs';
import {blockerPriceOptions} from '../../src/activity-price-comparison.mjs';

for(const scenario of ['switch','reverse','both-lower','manual-other','unknown'])test('native dual activity dry pages never submit and only an independently proven non-reducing target is created: '+scenario,{timeout:300000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-dual-native-')),product={productId:'300001',name:'双方案商品',skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60},{id:'500002',name:'规格乙',baseFen:12000,discount:60}]};
 const fixture=await fixtureServer({catalogProducts:[product],dropAfterSubmit:scenario==='unknown'}),browser=new DedicatedBrowser(join(dir,'browser'),{test:true,viewport:{width:1280,height:800}}),j=new Journal(join(dir,'journal.sqlite'));
 fixture.state.typePriceCaps=scenario==='reverse'?{'限时抢购':{},'限量抢购':{'500001':5900}}:{'限时抢购':{'500001':5900},'限量抢购':['both-lower','manual-other'].includes(scenario)?{'500001':5800}:{}};
 const accounts=new AccountRegistry(j);accounts.register({shopId:'900001'},'signin-dual-native');accounts.authorizeOriginal('900001');setDualActivityCarePolicy(j,'900001',{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true});
 const policy={shopId:'900001',excludedProductIds:[],originalRiskAllowed:true,allowMissingHistoricalSkus:true,liveEnabled:true,cutoverConfirmed:true},platform=new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),nativePrepare=platform.prepare.bind(platform),probes=[];
 if(scenario==='reverse'){
  const source=fixture.state.campaigns[0],now=Math.floor(Date.now()/1000)*1000;Object.assign(source,{type:'限量抢购',status:'进行中',startAt:now,endAt:now+7*86400000,autoRenew:true,risk:true,products:[],removals:[{productId:product.productId,name:product.name,reason:'商品活动价须调整，请重新核验价格'}]});
  j.remember({source:'verified-platform-history',complete:true,shopId:policy.shopId,...product,campaignId:source.id,type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}});
 }
 platform.prepare=async(task,options)=>{fixture.state.formActivityType=task.plans[0].type;return nativePrepare(task,options);};
 const nativeCheck=platform.priceCheck.bind(platform);platform.priceCheck=async task=>{const before=fixture.state.submits,observation=await nativeCheck(task);assert.equal(fixture.state.submits,before,'dry type page cannot submit');assert.equal(platform.drafts.size,0,'each dry page closes before the next one');probes.push({type:task.plans[0].type,rows:observation.rows.length,allCurrentPrices:observation.rows.every(r=>r.discount===60)});return observation;};
 let service=new GuardianService({journal:j,platform,policy});
 try{
  await service.tick();assert.equal(probes.length,2,JSON.stringify(j.events(20)));assert.deepEqual(new Set(probes.map(p=>p.type)),new Set(['限时抢购','限量抢购']));assert.ok(probes.every(p=>p.rows===2&&p.allCurrentPrices));
  if(['both-lower','manual-other'].includes(scenario)){const d=getDualActivityDecision(j,'900001',product.productId);assert.equal(d.approvalAllowed,true,JSON.stringify(d));assert.equal(fixture.state.submits,0);assert.equal(fixture.state.creates,0);assert.equal(fixture.state.risks,0);assert.equal(fixture.state.uploads,2);
   if(scenario==='manual-other'){const review=j.priceReview(d.reviewIds['限时抢购']),option=blockerPriceOptions(review,{reviews:j.priceReviews(policy.shopId),tasks:j.list(policy.shopId),now:Date.now(),dualDecision:d}).find(o=>o.activityType==='限量抢购'&&o.available&&o.validationStatus!=='unverified');assert.ok(option);service.decidePriceReview({reviewId:review.id,key:review.key,decision:'approve',dualPairKey:d.pairKey,optionId:option.id,optionKey:option.key,approvalContext:'recovery-blockers',confirmedSkuIds:option.rows.map(r=>r.id),acceptPriceAndRisk:true});
    await service.tick();assert.equal(fixture.state.submits,1,JSON.stringify(j.events(20)));assert.equal(service.status().verified,1);assert.equal(j.priceTarget(policy.shopId,product.productId).consent.exactPrices,true);assert.equal(j.list(policy.shopId).find(t=>t.phase==='verified').plans[0].type,'限量抢购');
   }
  }
  else{const target=j.priceTarget('900001',product.productId);assert.equal(target.type,scenario==='reverse'?'限时抢购':'限量抢购');assert.ok(validDualActivityApproval(j,target));assert.equal(fixture.state.submits,1,JSON.stringify(j.events(20)));assert.equal(fixture.state.creates,1);assert.equal(fixture.state.risks,1);assert.equal(fixture.state.uploads,3);assert.ok(fixture.state.seenPrices.every(p=>p.discount>=60));
   if(scenario==='unknown'){const unknown=j.list('900001').find(t=>t.phase==='unknown');assert.ok(unknown);service.stop();await browser.close();service=new GuardianService({journal:j,platform:new DoudianPlatform({browser,policy,journal:j,base:fixture.base}),policy});await service.tick();assert.equal(j.get(unknown.id).submitAttempts,1);assert.equal(probes.length,2);assert.equal(fixture.state.submits,1);}
   assert.equal(service.status().verified,1);assert.equal(service.status().unknown,0);
  }
  assert.equal(fixture.state.cancelAttempts,undefined);await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts','dual-native-'+scenario+'.json'),JSON.stringify({localFixtureOnly:true,headless:true,probes,submits:fixture.state.submits,creates:fixture.state.creates,risks:fixture.state.risks,uploads:fixture.state.uploads,verified:service.status().verified,unknown:service.status().unknown},null,2),'utf8');
 }finally{service.stop();await browser.close();j.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
