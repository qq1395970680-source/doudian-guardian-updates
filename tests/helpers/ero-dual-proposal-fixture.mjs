import {randomUUID} from 'node:crypto';
import {dualActivityFixture,dualDraftObservation} from './dual-activity-fixture.mjs';
import {fingerprint,planOriginalRestore,saleFen} from '../../src/policy.mjs';
import {applyPriceTarget} from '../../src/price-review.mjs';
import {applyCampaignPolicy} from '../../src/campaign-policy.mjs';
import {campaignChoice} from '../../src/campaign-choice.mjs';
import {activeDualActivityCareGrant,dualProbePlan,makeDualActivityDecision} from '../../src/dual-activity-recovery.mjs';

// Synthetic five-SKU shape: a previously human-confirmed filter at 210.56,
// current direct cap 112 in both clean drafts, and an ungrouped 3.5/5.3 export.
export function eroDualProposalFixture(journal,{now=Date.now(),capFen=11200,recordDecision=true}={}){
 const f=dualActivityFixture(journal,{now}),b=f.baseline;
 Object.assign(b,{name:'合成五规格滤芯测试商品',campaignId:'4500000000000000101',type:'限时抢购',rules:campaignChoice('限时抢购').rules});delete b.activityLimit;delete b.durationMs;
 b.skus=[['5500000000000000101','合成规格甲',131900],['5500000000000000102','合成规格乙',45600],['5500000000000000103','合成规格丙',22400],['5500000000000000104','合成规格丁',170600],['5500000000000000105','合成规格戊',60000]].map(([id,name,baseFen])=>({id,name,baseFen,discount:50}));journal.remember(b,now);
 const rows=b.skus.map((s,i)=>{const discount=i===2?94:i===3?43:50;return{id:s.id,name:s.name,baseFen:s.baseFen,historicalDiscount:s.discount,previousDiscount:s.discount,previousFen:saleFen(s.baseFen,s.discount),discount,saleFen:saleFen(s.baseFen,discount),bounds:{},evidence:[]};});
 const target={id:'synthetic-human-current-'+randomUUID(),key:'synthetic-human-confirmed-prices',shopId:b.shopId,productId:b.productId,name:b.name,historicalFingerprint:fingerprint(b),status:'approved',
  type:'限量抢购',rules:campaignChoice('限量抢购').rules,campaignTarget:campaignChoice('限量抢购'),rows,createdAt:now-1000,approvedAt:now-500,expiresAt:now+1800000,consent:{exactPrices:true,matchedRiskConfirmation:true,continueGuardingExactPrices:true}};
 journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(target.id,target.shopId,target.productId,target.status,JSON.stringify(target),now-500);journal.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(target.shopId,target.productId,target.id);
 const current={...structuredClone(b),complete:true,offShelf:false,observedAt:now},plan=applyCampaignPolicy(applyPriceTarget(planOriginalRestore(b,current,f.policy,now),target),journal),grant=activeDualActivityCareGrant(journal,b.shopId,now);
 const reason='该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。\n该商品各SKU售卖价，最高价需在最低价的5.3倍以内，请修改后再提交。';
 const removal={productId:b.productId,name:b.name,reason},loss={complete:true,active:false,observedAt:now,lossKey:'synthetic-fresh-risk-removal',removal,
  removalEvidence:{source:'live-platform-removal-export',complete:true,shopId:b.shopId,campaignId:'4500000000000000102',activityType:'限量抢购',observedAt:now,sha256:'a'.repeat(64),record:structuredClone(removal)}};
 const probes=['限时抢购','限量抢购'].map(type=>{const task={id:randomUUID(),title:'synthetic-dry-'+type,shopId:b.shopId,phase:'queued',plans:[dualProbePlan(plan,type,grant.choices)],submitAttempts:0,riskAttempts:0,lossEvidence:{complete:true,observedAt:now,lossKey:loss.lossKey,priceRules:[structuredClone(loss)]},dualProbe:{grantId:grant.id,choices:structuredClone(grant.choices),plan:structuredClone(plan)}};
  const errorsById=capFen==null?{}:{'5500000000000000103':['单品活动价￥210.56，需≤￥'+capFen/100]};return{type,task,observation:dualDraftObservation(task,{now,errorsById})};});
 const made=makeDualActivityDecision({plan,probes,now,journal}),decision=recordDecision?journal.recordDualActivityDecision(made,now):made;
 return{...f,baseline:b,plan,current,target,loss,probes,made,decision};
}
