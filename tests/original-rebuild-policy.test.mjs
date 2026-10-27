import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {fingerprint} from '../src/policy.mjs';

test('one shop-wide original rebuild consent covers later source changes while preserving prices and sold-out protection',async()=>{
 const {setOriginalRebuildPolicy,activeOriginalRebuildGrant}=await import('../src/original-rebuild-policy.mjs');
 const j=new Journal(':memory:'),now=Date.now(),shopId='900001';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId:'300001',campaignId:'400001',type:'限量抢购',
  historyAt:now-100000,durationMs:7*86400000,activityLimit:1000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},
  skus:[{id:'500001',name:'滤芯',baseFen:10000,discount:50}]};
 j.putSettings('application',{accounts:[{shopId,originalRiskAllowed:true}]});j.remember(baseline);
 const p=new DoudianPlatform({browser:{},policy:{shopId,originalRiskAllowed:true},journal:j});
 const c={id:baseline.campaignId,type:'限量抢购',status:'已结束',startAt:now-200000,endAt:now-100000,risk:false};
 const listing={complete:true,observedAt:now,campaigns:[c]},details=new Map([[c.id,{complete:true,observedAt:now,rules:baseline.rules,products:[]}]]);
 assert.throws(()=>setOriginalRebuildPolicy(j,shopId,{enabled:true}),{code:'ORIGINAL_REBUILD_CONSENT_REQUIRED'});
 assert.throws(()=>p.lossFrom(baseline,listing,details,true,true),{code:'LIMITED_LOSS_UNPROVEN'});
 setOriginalRebuildPolicy(j,shopId,{enabled:true,acceptOriginalRebuild:true},now);
 const grant=activeOriginalRebuildGrant(j,shopId,now);assert.ok(grant);
 const loss=p.lossFrom(baseline,listing,details,true,true);
 assert.equal(loss.continuity.kind,'authorized-original-rebuild');assert.equal(loss.continuity.grantId,grant.id);
 assert.equal(loss.continuity.historicalFingerprint,fingerprint(baseline));assert.equal(j.priceReviews(shopId).length,0);
 const absent={...listing,campaigns:[],referenceLookup:{campaignId:c.id,complete:true,observedAt:now,matchingIds:[]}};
 assert.equal(p.lossFrom(baseline,absent,new Map(),true,true).continuity.grantId,grant.id);
 details.set(c.id,{...details.get(c.id),products:[{productId:baseline.productId,soldOut:true}]});
 assert.throws(()=>p.lossFrom(baseline,listing,details,true,true),{code:'LIMITED_LOSS_UNPROVEN'});
 setOriginalRebuildPolicy(j,shopId,{enabled:false},now+1);
 assert.equal(activeOriginalRebuildGrant(j,shopId,now+1),null);
 assert.throws(()=>p.lossFrom(baseline,{...listing,campaigns:[]},new Map(),true,true),{code:'LIMITED_LOSS_UNPROVEN'});
 j.close();
});
