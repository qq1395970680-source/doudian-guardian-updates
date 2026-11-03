import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {createApp} from '../../src/server.mjs';
import {planOriginalRestore} from '../../src/policy.mjs';
import {dualProbePlan,makeDualActivityDecision} from '../../src/dual-activity-recovery.mjs';
import {dualActivityFixture,dualDraftObservation} from './dual-activity-fixture.mjs';

// Real independent pair material and handlers, with no running scheduler.
export async function dualPriceUiFixture({skuCount=2,now=Date.now()-1000,caps={'限时抢购':5900,'限量抢购':5900},mixed=false}={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-dual-price-ui-')),journal=new Journal(':memory:'),f=dualActivityFixture(journal,{now,caps});
 if(skuCount!==2){f.baseline.skus=Array.from({length:skuCount},(_,i)=>({id:String(5500000000000000000n+BigInt(i+1)),name:'滤芯规格 '+(i+1),baseFen:13900,discount:50}));journal.remember(f.baseline,now+1);}
 const current={...structuredClone(f.baseline),complete:true,offShelf:false,observedAt:now},plan=planOriginalRestore(f.baseline,current,f.policy,now);
 const probes=['限时抢购','限量抢购'].map(type=>{const task={id:randomUUID(),title:'ui-independent-'+type,shopId:plan.shopId,phase:'queued',plans:[dualProbePlan(plan,type)],submitAttempts:0,riskAttempts:0};
  const errorsById=mixed?{[plan.skus[0].id]:['活动价不得高于68元'],[plan.skus[1].id]:['活动价不得低于70元']}:{};
  return{type,task,observation:dualDraftObservation(task,{now,capFen:mixed?null:caps[type],errorsById})};});
 const decision=journal.recordDualActivityDecision(makeDualActivityDecision({plan,probes,now}),now),review=journal.priceReview(decision.reviewIds[plan.type]);
 const platform={progress:{stage:'隔离界面核验'},probe:async()=>({shopId:plan.shopId,name:'双方案界面测试店'})};
 const service=new GuardianService({journal,platform,policy:f.policy,immediate:false});
 const app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 platform.onAuthenticated({shopId:plan.shopId,name:'双方案界面测试店'});
 return{runtime,journal,f,plan,probes,decision,review,platform,service,app,async close(){await app.close();await rm(runtime,{recursive:true,force:true});}};
}
