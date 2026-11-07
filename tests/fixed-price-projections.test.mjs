import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {planOriginalRestore,fingerprint} from '../src/policy.mjs';
import {makeTransfer,validateTransfer,importTransfer} from '../src/migration.mjs';
import {buildRecoveryHistory} from '../src/recovery-history.mjs';
import {buildCatalog} from '../src/catalog.mjs';
import {submissionReadbackObservation} from '../src/submission-investigation.mjs';
const at=1794039000000,shopId='900001';
function fixture(limited){
 const baseline={priceMode:'fixed',source:'verified-platform-history',complete:true,shopId,productId:'300001',name:'固定分测试',campaignId:'400001',historyAt:at-100000,observedAt:at,
  type:limited?'限量抢购':'限时抢购',rules:{noLimit:!limited,noPerUserLimit:true,noWarmup:true,orderMinutes:30,...(limited?{autoRenew:true}:{})},...(limited?{activityLimit:777,durationMs:604800000}:{}),
  skus:[{id:'500001',name:'规格甲',baseFen:9999,discount:null,saleFen:4739,saleSource:'observed'}]};
 const policy={shopId,excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:true};
 const current={shopId,productId:baseline.productId,complete:true,observedAt:at,skus:structuredClone(baseline.skus)};
 return{baseline,policy,plan:planOriginalRestore(baseline,current,policy,at)};
}
for(const limited of [false,true])test('fixed '+(limited?'limited':'timed')+' task and arbitrary fen survive migration without carrying lower-price or execution consent',()=>{
 const source=new Journal(':memory:'),target=new Journal(':memory:');
 try{
  const f=fixture(limited);source.remember(f.baseline,at);const task=source.enqueue(shopId,[f.plan],{complete:true,observedAt:at,lossKey:'projection-fixed'},at);
  if(limited)assert.match(task.title,/^守护2-一口价-/);
  const file=makeTransfer(source,{shopId,name:'测试店铺',excludedProductIds:[]},{version:'2.0.0-beta.65',now:at+1}),view=validateTransfer(file,shopId,at+2);
  assert.equal(view.products[0].priceMode,'fixed');assert.deepEqual(view.products[0].skus.map(s=>[s.discount,s.saleFen]),[[null,4739]]);
  const result=importTransfer(target,file,{shopId,accepted:true,expectedDigest:file.digest},at+2);assert.equal(result.importedHistories,1);assert.equal(target.histories(shopId)[0].priceMode,'fixed');
  assert.equal(target.priceTarget(shopId,f.baseline.productId),null);assert.equal(target.settings(shopId),null);
  const bad=structuredClone(file);delete bad.payload.tasks[0].plans[0].priceMode;bad.digest=fingerprint(bad.payload);
  assert.throws(()=>validateTransfer(bad,shopId,at+2));
 }finally{source.close();target.close();}
});
test('fixed catalog and submission observations retain explicit mode; historical display does not overwrite the original amount',()=>{
 const f=fixture(false),campaign={id:'400002',name:'守护2-000000000000000000',type:'限时抢购',status:'进行中',startAt:at,endAt:at+172800000};
 const detail={priceMode:'fixed',complete:true,shopId,observedAt:at,rules:f.baseline.rules,products:[{productId:'300001',name:'固定分测试',skus:f.baseline.skus}]};
 const catalog=buildCatalog({shopId,histories:[f.baseline],inventory:{listing:{complete:true,observedAt:at,campaigns:[campaign]},activeComplete:true,details:new Map([[campaign.id,detail]])},now:at});
 assert.equal(catalog.products[0].history.priceMode,'fixed');assert.equal(catalog.products[0].current[0].priceMode,'fixed');
 assert.equal(submissionReadbackObservation({shopId},campaign,detail).priceMode,'fixed');
 const plan={...f.plan,skus:f.plan.skus.map(s=>({...s,originalSaleFen:4739,saleFen:4567}))};
 const task={id:'test-task',shopId,phase:'verified',submitAttempts:1,createdAt:at,updatedAt:at+1,plans:[plan],receipt:{campaignId:campaign.id,verifiedAt:at+1,evidenceFingerprint:'a'.repeat(64),productCount:1,skuCount:1}};
 const row=buildRecoveryHistory({shopId,tasks:[task]}).records[0];assert.equal(row.priceMode,'fixed');assert.equal(row.skus[0].historicalSaleFen,4739);assert.equal(row.skus[0].saleFen,4567);
});
