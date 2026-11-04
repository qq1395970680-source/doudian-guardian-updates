import {Journal} from '../../src/journal.mjs';
import {AccountRegistry} from '../../src/accounts.mjs';
import {planOriginalRestore,fingerprint} from '../../src/policy.mjs';
import {makeRemovalPriceReview} from '../../src/ratio-prices.mjs';
import {setCareRecoveryPolicy} from '../../src/care-recovery-policy.mjs';
import {setDualActivityCarePolicy,activeDualActivityCareGrant,dualProbePlan} from '../../src/dual-activity-recovery.mjs';
import {applyPriceTarget} from '../../src/price-review.mjs';
import {applyCampaignPolicy} from '../../src/campaign-policy.mjs';
import {assertDualPriceBasis} from '../../src/legacy-price-floor.mjs';

const material=r=>Object.fromEntries(Object.entries(r).filter(([key])=>!['id','key','source','taskId','sourceProof','createdAt','expiresAt','status'].includes(key)));
export function legacyPriceFloorFixture(){
 const j=new Journal(':memory:'),now=Date.now(),accounts=new AccountRegistry(j),shopId='900001',productId='300001';
 accounts.register({shopId},'signin-legacy-price-floor');accounts.authorizeOriginal(shopId);
 const care=setCareRecoveryPolicy(j,shopId,{enabled:true,acceptNonReducingRecovery:true},now-1000);
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,name:'多倍率旧目标回归商品',campaignId:'400001',type:'限量抢购',durationMs:7*86400000,activityLimit:1000,
  rules:{noLimit:false,noPerUserLimit:true,noWarmup:true,orderMinutes:30,autoRenew:true},skus:[13000,10000,8500,7500,6000,5800,6500,5800,5800,2800].map((baseFen,index)=>({id:String(500001+index),name:'规格'+(index+1),baseFen,discount:60}))};
 j.remember(baseline,now-800);
 const current={shopId,productId,complete:true,offShelf:false,observedAt:now,skus:baseline.skus.map(s=>({id:null,idSource:'unavailable-in-create-form',name:s.name,baseFen:s.baseFen}))};
 const policy={shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true,excludedProductIds:[],liveEnabled:true,cutoverConfirmed:true},original=planOriginalRestore(baseline,current,policy,now);
 const reason='该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。',record={productId,name:baseline.name,reason};
 const loss={complete:true,active:false,observedAt:now-100,lossKey:'original-removal-proof',removal:record,
  removalEvidence:{source:'live-platform-removal-export',complete:true,shopId,campaignId:baseline.campaignId,activityType:baseline.type,observedAt:now-100,sha256:'a'.repeat(64),record}};
 const {fingerprint:oldFingerprint,...body}=original,oldPlan={...body,observedAt:now-100};oldPlan.fingerprint=fingerprint(oldPlan);
 const proposal=makeRemovalPriceReview(oldPlan,loss,now-100),ambiguous=reason+'\n'+reason.replace('3.5','5.3');
 proposal.sourceProof.record.reason=ambiguous;for(const row of proposal.rows)row.evidence=[ambiguous];proposal.key=fingerprint(material(proposal));
 const saved=j.savePriceReview(proposal,now-100);
 // A historical database snapshot, not a new approval through the current
 // parser. This is the sanitized ten-SKU shape of a formerly accepted target.
 const approved={...structuredClone(saved),status:'approved',approvedAt:now-90,approvalKind:'automatic-price-increase',careSource:structuredClone(saved),careEvidence:{}};
 approved.automaticConsent={careGrantId:care.grantId,targetsFingerprint:fingerprint(approved.rows),sourceFingerprint:fingerprint(approved.careSource),evidenceFingerprint:fingerprint(approved.careEvidence),continueGuardingExactPrices:true};
 j.db.prepare('UPDATE price_reviews SET state=?,body=?,updated=? WHERE id=?').run('approved',JSON.stringify(approved),now-90,approved.id);
 j.db.prepare('INSERT INTO price_targets VALUES(?,?,?)').run(shopId,productId,approved.id);
 setCareRecoveryPolicy(j,shopId,{enabled:false},now-50);
 setDualActivityCarePolicy(j,shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},now-10);
 const plan=applyCampaignPolicy(applyPriceTarget(original,approved),j),grant=activeDualActivityCareGrant(j,shopId,now);
 return{j,now,baseline,current,policy,plan,original,approved,grant};
}

export function legacyNativeProbe(f,type,{errors={},at=f.now,legacyPriceFloor=assertDualPriceBasis(f.j,f.plan,f.now)}={}){
 const target=dualProbePlan(f.plan,type,f.grant.choices),task={id:'probe-'+type,shopId:f.plan.shopId,title:'旧目标重新取证-'+type,phase:'queued',plans:[target],submitAttempts:0,riskAttempts:0,
  dualProbe:{grantId:f.grant.id,choices:structuredClone(f.grant.choices),plan:structuredClone(f.plan),...(legacyPriceFloor?{legacyPriceFloor}:{} )}};
 const observation=legacyDraftObservation(task,at,errors);
 return{type,task,observation};
}
export function legacyDraftObservation(task,at,errors={}){
 const plan=task.plans[0],rows=plan.skus.map(s=>({...s,productId:plan.productId,errors:errors[s.id]||[]}));
 return{source:'live-platform-draft',kind:'draft',complete:true,shopId:task.shopId,title:task.title,type:plan.type,rules:structuredClone(plan.rules),
  observedAt:at,startAt:at,endAt:at+plan.durationMs,rows,warnings:[...new Set(rows.flatMap(r=>r.errors))],dialogs:[],
  ...(plan.type==='限量抢购'?{productLimits:[{productId:plan.productId,activityLimit:plan.activityLimit}]}:{})};
}
