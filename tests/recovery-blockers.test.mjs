import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecoveryBlockers} from '../src/recovery-blockers.mjs';
const shopId='900001',now=Date.now(),productId='300001';
function fixture(){
 const sku={id:'500001',name:'测试规格',baseFen:10000,discount:50,saleFen:5000};
 const tasks=['限时抢购','限量抢购'].map((type,i)=>({id:'task'+i,shopId,phase:'blocked',submitAttempts:0,updatedAt:now-100+i,
  reason:'PRICE_REVIEW_REQUIRED: 平台价格上限不允许',plans:[{productId,type,historicalFingerprint:'history',skus:[{...sku}]}]}));
 const reviews=tasks.map(t=>({shopId,productId,taskId:t.id,type:t.plans[0].type,historicalFingerprint:'history',source:'live-platform-draft',status:'superseded',createdAt:t.updatedAt,
  rows:[{...sku,previousDiscount:50,previousFen:5000}]}));
 return{shopId,now,catalog:{products:[{productId,name:'测试商品',current:[],scheduled:[],excluded:false}]},tasks,reviews};
}
test('only two independently recorded rejections for the same exact price context enter both-blocked',()=>{
 const f=fixture(),result=buildRecoveryBlockers(f);assert.equal(result.counts.bothBlocked,1);assert.equal(result.records[0].schemes['限量抢购'].state,'blocked');
 assert.equal(buildRecoveryBlockers({...f,reviews:f.reviews.slice(0,1)}).counts.bothBlocked,0);
 const changed=fixture();changed.tasks[1].plans[0].skus[0].discount=60;changed.tasks[1].plans[0].skus[0].saleFen=6000;
 changed.reviews[1].rows[0].previousDiscount=60;changed.reviews[1].rows[0].previousFen=6000;
 assert.equal(buildRecoveryBlockers(changed).counts.bothBlocked,0);
});
test('current activities, exclusions, changed approved targets and unknown submissions prevent a both-failed claim',()=>{
 for(const change of ['active','excluded','unknown','target','cross-shop','missing-proof']){
  const f=fixture();if(change==='active')f.catalog.products[0].current=[{campaignId:'400001'}];
  if(change==='excluded')f.catalog.products[0].excluded=true;
  if(change==='unknown')f.tasks.push({...f.tasks[0],id:'unknown',phase:'unknown'});
  if(change==='target')f.targets=[{shopId,productId,historicalFingerprint:'history',rows:[{id:'500001',name:'测试规格',baseFen:10000,discount:60,saleFen:6000}]}];
  if(change==='cross-shop')f.reviews[1].shopId='900002';
  if(change==='missing-proof')f.reviews[1].source='diagnostic-only';
  assert.equal(buildRecoveryBlockers(f).counts.bothBlocked,0,change);
 }
});
test('an independently recorded removal rejection only covers its explicitly identified source type',()=>{
 const f=fixture(),r=f.reviews[1];r.source='live-platform-removal-export';r.taskId=null;
 r.sourceProof={source:'live-platform-removal-export',shopId,complete:true,activityType:'限量抢购',observedAt:r.createdAt,
  sha256:'a'.repeat(64),record:{productId,reason:'SKU价差超过平台限制'}};
 assert.equal(buildRecoveryBlockers(f).counts.bothBlocked,1);
 r.sourceProof.activityType='限时抢购';assert.equal(buildRecoveryBlockers(f).counts.bothBlocked,0);
 delete r.sourceProof.activityType;assert.equal(buildRecoveryBlockers(f).counts.bothBlocked,0);
});
