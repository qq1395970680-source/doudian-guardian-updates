import {randomUUID} from 'node:crypto';
import {blockerFixture} from './blocker-prices-fixture.mjs';
import {dualDraftObservation} from './dual-activity-fixture.mjs';
import {dualProbePlan,makeDualActivityDecision,setDualActivityCarePolicy} from '../../src/dual-activity-recovery.mjs';

export function seedDualDrafts(journal,plan,{now=Date.now(),caps={'限时抢购':6800,'限量抢购':6500},pendingType=null,ratioLoss=null}={}){
 const probes=['限时抢购','限量抢购'].map((type,index)=>{
  if(type===pendingType)return{type,error:{code:'READ_OPERATION_TIMEOUT',message:'本类型独立草稿尚未完整读取'}};
  const task={id:randomUUID(),title:'独立UI验收草稿-'+type,shopId:plan.shopId,phase:'queued',plans:[dualProbePlan(plan,type)],submitAttempts:0,riskAttempts:0};
  if(ratioLoss){const loss=structuredClone(ratioLoss);loss.removalEvidence={...loss.removalEvidence,activityType:type,campaignId:index?'400012':'400011',sha256:(index?'b':'a').repeat(64),observedAt:now};loss.observedAt=now;task.lossEvidence={priceRules:[loss]};}
  return{type,task,observation:dualDraftObservation(task,{now,capFen:caps[type]})};
 });
 return journal.recordDualActivityDecision(makeDualActivityDecision({plan,probes,now}),now);
}
export async function dualBlockerFixture(options={}){
 const x=await blockerFixture();
 try{
  setDualActivityCarePolicy(x.journal,x.review.shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true});
  const pair=seedDualDrafts(x.journal,x.f.plan,options),review=x.journal.priceReview(pair.schemes.find(s=>s.type==='限时抢购')?.reviewId||pair.schemes.find(s=>s.reviewId)?.reviewId);
  return{...x,originalSingleReview:x.review,pair,review};
 }catch(error){await x.close();throw error;}
}
export async function openDualPriceWorkspace(page,productId,{scope='confirm'}={}){
 await page.locator('[data-view="workspace"]').click();await page.locator('[data-workspace-scope="'+scope+'"]').click();
 await page.locator('#price-reviews [data-workspace-product="'+productId+'"] [data-open-price-review]').click();
 const dialog=page.locator('dialog[data-price-workspace]');await dialog.locator('[data-review-id]').waitFor();return dialog;
}
