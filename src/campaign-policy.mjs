import {fingerprint,requireThat,id,validateHistorical,validateLimited,isLimited} from './policy.mjs';
import {approvedCampaignChoice} from './campaign-choice.mjs';

const key=shopId=>'campaign-policy:'+id(shopId);
const historyKey=baseline=>{const{observedAt,...stable}=baseline;return fingerprint(stable);};
export function campaignPolicy(journal,shopId){return journal.settings(key(shopId));}
export function setCampaignPolicy(journal,shopId,target,baselines,consent,now=Date.now()){
 id(shopId);requireThat(isLimited(target),'CAMPAIGN_POLICY_INVALID','目前仅支持明确切换到限量抢购');
 validateLimited(target);
 requireThat(target.rules.noPerUserLimit===true&&target.rules.noWarmup===true&&target.rules.orderMinutes===30,
  'CAMPAIGN_POLICY_INVALID','迁移规则必须明确');
 requireThat(consent?.confirmed===true&&consent.source==='human-request'&&typeof consent.requestId==='string'&&consent.requestId.length>0,
  'CAMPAIGN_POLICY_CONSENT','变更活动类型需要明确的店铺范围和规则授权');
 requireThat(Array.isArray(baselines)&&baselines.length>0&&new Set(baselines.map(b=>b.productId)).size===baselines.length,
  'CAMPAIGN_POLICY_SOURCE','迁移来源为空或商品重复');
 const saved=journal.histories(shopId),canonicalBaselines=[];
 for(const b of baselines){
  validateHistorical(b);
  const canonical=saved.find(s=>historyKey(s)===historyKey(b));
  requireThat(b.shopId===shopId&&canonical&&b.observedAt>0&&b.observedAt<=now+5000&&now-b.observedAt<=30*60000,
   'CAMPAIGN_POLICY_SOURCE','迁移必须来自本店新鲜且完整的平台读取');
  canonicalBaselines.push(canonical);
 }
 const prior=campaignPolicy(journal,shopId);
 requireThat(!prior||prior.requestId===consent.requestId,'CAMPAIGN_POLICY_CHANGED','已有另一份活动迁移配置');
 const value={schema:1,shopId,requestId:consent.requestId,source:'human-request',target:structuredClone(target),
  preferredBaselines:Object.fromEntries(canonicalBaselines.map(b=>[b.productId,fingerprint(b)])),createdAt:now};
 journal.putSettings(key(shopId),value);
 journal.event(null,'campaign-policy-set',{shopId,requestId:value.requestId,target:value.target,products:baselines.length},now);return value;
}
export function preferCampaignBaselines(journal,shopId,latest){
 const policy=campaignPolicy(journal,shopId);if(!policy)return latest;
 const histories=journal.histories(shopId);
 for(const [productId,hash]of Object.entries(policy.preferredBaselines)){
  const selected=histories.find(b=>b.productId===productId&&fingerprint(b)===hash);
  requireThat(selected,'CAMPAIGN_POLICY_SOURCE','迁移原始完整记录缺失，暂停恢复');
  // A subsequently created human activity becomes the new source. Generated
  // recovery activities never replace exact approved price targets.
  const manual=latest.get(productId);
  if(!manual||manual.generatedByGuardian||!(manual.historyAt>selected.historyAt))latest.set(productId,selected);
 }
 return latest;
}
export function applyCampaignPolicy(plan,journal){
 const review=journal.priceTarget(plan.shopId,plan.productId),choice=approvedCampaignChoice(review,plan);
 if(choice){
  const {fingerprint:previous,...base}=plan;
  const result={...base,...structuredClone(choice),campaignTarget:structuredClone(choice),productCampaignApprovalId:review.id};
  delete result.campaignPolicyFingerprint;
  return{...result,fingerprint:fingerprint(result)};
 }
 const policy=campaignPolicy(journal,plan.shopId);if(!policy)return plan;
 const {fingerprint:previous,...base}=plan;
 const result={...base,...structuredClone(policy.target),campaignPolicyFingerprint:fingerprint(policy)};
 return {...result,fingerprint:fingerprint(result)};
}
export function assertCampaignPolicy(journal,shopId,plans){
 const policy=campaignPolicy(journal,shopId);
 for(const plan of plans){
  const review=journal.priceTarget(shopId,plan.productId),choice=approvedCampaignChoice(review,plan);
  if(choice){
   requireThat(plan.productCampaignApprovalId===review.id&&
    fingerprint({type:plan.type,rules:plan.rules,activityLimit:plan.activityLimit,durationMs:plan.durationMs})===fingerprint(choice),
    'CAMPAIGN_CHOICE_CHANGED','执行活动类型或规则与本商品确认方案不一致');
   continue;
  }
  requireThat(!plan.productCampaignApprovalId&&!plan.campaignTarget,'CAMPAIGN_CHOICE_CHANGED','商品活动方案已变化');
  if(!policy){requireThat(!plan.campaignPolicyFingerprint,'CAMPAIGN_POLICY_CHANGED','活动规则授权已变化');continue;}
  requireThat(plan.shopId===shopId&&plan.campaignPolicyFingerprint===fingerprint(policy)&&
   fingerprint({type:plan.type,rules:plan.rules,activityLimit:plan.activityLimit,durationMs:plan.durationMs})===fingerprint(policy.target),
   'CAMPAIGN_POLICY_CHANGED','执行活动类型、限量或续期与当前授权不一致');
 }
}
