import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {makePriceReviews} from '../../src/price-review.mjs';
import {makeTransfer} from '../../src/migration.mjs';
import {setOriginalPriceRecoveryPolicy} from '../../src/original-price-recovery-policy.mjs';
import {setOriginalRebuildPolicy} from '../../src/original-rebuild-policy.mjs';
import {fingerprint} from '../../src/policy.mjs';
import {priceFixture} from './price-review-fixture.mjs';
import {recoveryTask,seedRecoveries} from './recovery-fixture.mjs';
import {seedLimitedRejection} from './activity-price-fixture.mjs';
import {setDualActivityCarePolicy} from '../../src/dual-activity-recovery.mjs';
import {seedDualDrafts} from './dual-price-ui-fixture.mjs';
import {applyCampaignPolicy} from '../../src/campaign-policy.mjs';

export const workspaceViews=['overview','workspace','recoveries','accounts','activity','updates'];
export const workspaceShopId='900001';

// In-memory journals, a loopback port selected by the OS, fake platform data,
// and a non-executing service keep this visual matrix away from real shops.
export async function workspaceRedesignFixture({empty=false}={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-workspace-redesign-'));
 const journal=new Journal(':memory:'),now=Date.now()-1500,shopId=workspaceShopId;
 const products=Array.from({length:37},(_,i)=>({productId:String(310000+i),name:['家用净水器复合滤芯','五级超滤净水器滤芯套装','反渗透净水器长效滤芯'][i%3]+' · '+(i+1),
  skus:Array.from({length:i===0?32:3},(_,n)=>({id:String(610000+i*100+n),name:'滤芯规格 '+(n+1),baseFen:10000+n*1200,discount:50,saleFen:5000+n*600}))}));
 const inventory={listing:{complete:true,observedAt:now,campaigns:empty?[]:[{id:'410001',name:'隔离演示活动',type:'限量抢购',status:'进行中',startAt:now-3600000,endAt:now+86400000}]},activeComplete:true,
  details:new Map(empty?[]:[['410001',{complete:true,observedAt:now,products}]])};
 let activeReview=null,priceProductId=null,priceSeed=null;
 if(!empty){
  const f=priceFixture(journal,now),r=journal.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);
  journal.transition(f.task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED: 活动价不得高于近15天最低价（68元）'},now);
  seedLimitedRejection(journal,f,r,{at:now-10});activeReview=r;priceProductId=r.productId;priceSeed=f;
  const history=Array.from({length:27},(_,i)=>recoveryTask(100+i,{skuCount:i===0?27:3}));
  const unknowns=[recoveryTask(200,{phase:'unknown'}),recoveryTask(201,{phase:'unknown'})];
  for(const t of unknowns){t.reason='LOAD_TIMEOUT: 提交结果等待独立回读';t.riskAttempts=t===unknowns[0]?0:1;}
  seedRecoveries(journal,[...history,...unknowns]);
  const readFailure={...structuredClone(f.baseline),productId:'390001',name:'正在核对的滤芯商品',campaignId:'490001'};
  journal.remember(readFailure,now);
  journal.putProductCheck(shopId,readFailure.productId,{code:'LOAD_TIMEOUT',message:'平台活动详情暂未完整读取，等待重新核对',at:now,retryAt:now+60000},now);
  for(const [id,body] of [['declined-price','declined'],['expired-price','pending'],['approved-price','approved']]){
   const review={...structuredClone(r),id,key:id+'-key',productId:body==='declined'?'390002':id==='expired-price'?'390003':'390004',name:body==='declined'?'已选择暂不调整的商品':id==='expired-price'?'过期建议商品':'历史已确认商品',status:body,
    createdAt:now-10000,expiresAt:id==='expired-price'?now-1:now+1800000,taskId:null};
   const baseline={...structuredClone(f.baseline),productId:review.productId,name:review.name,campaignId:String(490000+Number(review.productId)-390000)};
   journal.remember(baseline,now-10000);review.historicalFingerprint=fingerprint(baseline);
   journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(review.id,shopId,review.productId,review.status,JSON.stringify(review),review.createdAt);
  }
  for(let n=0;n<12;n++)journal.event(null,n%3===0?'product-blocked':'verification-pending',{shopId,productId:String(390001+n),message:n%3===0?'商品平台要求待核验':'已保存提交结果，继续独立回读'},now-n*10000);
 }
 const service={running:!empty,busy:false,immediateEnabled:false,
  status:()=>({unknown:empty?0:2,verified:empty?0:27,blocked:empty?0:2,nextAt:now+60000,lastSuccessfulRun:empty?null:{ok:true,startedAt:now-10000,finishedAt:now},
   tasks:empty?[]:journal.list(shopId).slice(0,100).map(t=>({id:t.id,title:t.title,phase:t.phase,products:t.plans.map(p=>p.name||p.productId),reason:t.reason,updatedAt:t.updatedAt,receipt:t.receipt||null}))}),
  stop(){this.running=false;},start(){assert.fail('Visual matrix cannot start business execution');},
  requestRecovery(){assert.fail('Visual matrix cannot enqueue business recovery');},
  decidePriceReview(){assert.fail('Visual matrix cannot approve a new price');},
  latestHistories:()=>new Map(journal.histories(shopId).map(h=>[h.productId,h]))};
 const platform={inventory,progress:{stage:empty?'等待连接店铺':'本轮活动核对完成',read:empty?0:37,total:empty?0:37},
  probe:async()=>({shopId,name:'全界面隔离验收店铺'}),discover:async()=>({activeComplete:true,baselines:[],errors:[]})};
 const app=await createApp({config:empty?{}:{shopId,name:'全界面隔离验收店铺',originalRiskAllowed:true,excludedProductIds:['399999']},runtime:join(runtime,'server'),port:0,
  dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 if(!empty){
  platform.onAuthenticated({shopId,name:'全界面隔离验收店铺'});
  setDualActivityCarePolicy(journal,shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},now);
  setOriginalPriceRecoveryPolicy(journal,shopId,{enabled:true,acceptOriginalPricesOnly:true},now);
  setOriginalRebuildPolicy(journal,shopId,{enabled:true,acceptOriginalRebuild:true},now);
  // snapshot() reads this setting after spreading service.status(), so this
  // deliberately exercises the exact former limited-campaign banner branch.
  journal.putSettings('campaign-policy:'+shopId,{target:{type:'限量抢购',activityLimit:1000,durationMs:7*86400000,rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true}}});
  const pair=seedDualDrafts(journal,applyCampaignPolicy(priceSeed.plan,journal),{now,caps:{'限时抢购':6800,'限量抢购':6500}});activeReview=journal.priceReview(pair.reviewIds['限量抢购']);
 }
 const transferSource=new Journal(':memory:'),tf=priceFixture(transferSource,now);
 const transferFile=makeTransfer(transferSource,{...tf.policy,name:'迁移预览隔离店铺'},{version:'2.0.0-beta.59',now});
 const emptySource=new Journal(':memory:'),emptyTransferFile=makeTransfer(emptySource,{shopId,name:'空迁移预览'},{version:'2.0.0-beta.59',now});
 transferSource.close();emptySource.close();
 return{app,journal,service,platform,runtime,shopId,empty,activeReview,priceProductId,transferFile,emptyTransferFile,
  snapshot(){return{tasks:journal.list(shopId).map(t=>({id:t.id,phase:t.phase,submitAttempts:t.submitAttempts,riskAttempts:t.riskAttempts})),targets:journal.db.prepare('SELECT COUNT(*) AS n FROM price_targets').get().n};},
  async close(){await app.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}
