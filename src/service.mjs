import {randomUUID} from 'node:crypto';
import {planOriginalRestore,proveDraft,proveReadback,fingerprint,requireThat,restorationGroupKey} from './policy.mjs';
import {preferCampaignBaselines,applyCampaignPolicy} from './campaign-policy.mjs';
import {PriorityWatch,currentListingKey} from './priority-watch.mjs';
import {applyPriceTarget,makePriceReviews} from './price-review.mjs';
import {activePriceIncreaseGrant,isAutomaticPriceIncrease} from './price-increase-policy.mjs';
import {recoveryBatches,readBatchProducts} from './recovery-batches.mjs';
import {checkRemovalPrices} from './removal-export.mjs';

const displayRun=(run,now)=>run&&typeof run.ok==='boolean'&&Number.isFinite(run.startedAt)&&Number.isFinite(run.finishedAt)&&run.startedAt>0&&run.finishedAt>=run.startedAt&&run.finishedAt<=now+5000?
 {startedAt:run.startedAt,finishedAt:run.finishedAt,ok:run.ok,...(run.code?{code:String(run.code).slice(0,80)}:{}),...(run.message?{message:String(run.message).slice(0,1000)}:{})}:null;

export class GuardianService {
  constructor({journal,platform,policy,now=()=>Date.now()}) {
    this.journal=journal;this.platform=platform;this.policy=policy;this.now=now;this.owner=randomUUID();
    this.running=false;this.busy=false;this.timer=null;this.lastRun=null;this.lastSuccessfulRun=null;this.nextAt=null;this.stopRequested=false;
    const patrol=policy.shopId?journal.settings('patrol-display:'+policy.shopId):null;
    if(patrol?.schema===1&&patrol.shopId===policy.shopId&&patrol.source==='completed-program-patrol'){
      this.lastRun=displayRun(patrol.lastRun,this.now());const success=displayRun(patrol.lastSuccessfulRun,this.now());this.lastSuccessfulRun=success?.ok?success:null;
    }
    this.recovered=false;this.lastHistoryRead=this.now();
    this.priceIncreaseFollowups=new Set();
    this.priorityWatch=null;this.priorityListing=null;this.lastPriorityPoll=0;this.priorityPoll=null;this.priorityResume=false;this.lastPriorityCheck=null;
    this.platform.assertWrite=()=>{requireThat(!this.stopRequested&&this.policy.liveEnabled&&this.policy.cutoverConfirmed,'STOPPED','后台写入已停止');this.journal.assertLease(this.policy.shopId,this.owner,this.now());};
  }
  status() {
    const tasks=this.policy.shopId?this.journal.list(this.policy.shopId):[];
    return {shopId:this.policy.shopId,running:this.running,busy:this.busy,nextAt:this.nextAt,lastRun:this.lastRun,lastSuccessfulRun:this.lastSuccessfulRun,lastPriorityCheck:this.lastPriorityCheck,
      verified:tasks.filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0),unknown:tasks.filter(t=>['submitting','unknown','verifying'].includes(t.phase)).length,
      blocked:tasks.filter(t=>t.phase==='blocked').length,
      tasks:tasks.slice(0,100).map(t=>({id:t.id,title:t.title,phase:t.phase,products:t.plans.map(p=>p.productId),updatedAt:t.updatedAt,reason:t.reason||null,receipt:t.receipt||null}))};
  }
  recordRun(run){
    this.lastRun=run;if(run.ok)this.lastSuccessfulRun=run;
    // This record is presentation only; it cannot start a task, grant consent
    // or turn incomplete inventory into evidence of a missing discount.
    this.journal.putSettings('patrol-display:'+this.policy.shopId,{schema:1,shopId:this.policy.shopId,source:'completed-program-patrol',lastRun:this.lastRun,lastSuccessfulRun:this.lastSuccessfulRun});
  }
  latestHistories() {
    const latest=new Map(),histories=this.journal.histories(this.policy.shopId).sort((a,b)=>Number(!!a.generatedByGuardian)-Number(!!b.generatedByGuardian)||(b.historyAt||0)-(a.historyAt||0));
    for(const baseline of histories)if(!latest.has(baseline.productId))latest.set(baseline.productId,baseline);
    return preferCampaignBaselines(this.journal,this.policy.shopId,latest);
  }
  restorePlan(baseline,current) {
    return applyCampaignPolicy(applyPriceTarget(planOriginalRestore(baseline,current,this.policy,this.now()),this.journal.priceTarget(this.policy.shopId,baseline.productId)),this.journal);
  }
  decidePriceReview(args) {
    const review=this.journal.priceReview(args.reviewId),baseline=review&&this.latestHistories().get(review.productId);
    requireThat(review?.shopId===this.policy.shopId&&baseline&&!this.policy.excludedProductIds?.includes(review.productId),'PRICE_REVIEW_CHANGED','店铺、历史或排除设置已变化');
    return this.journal.decidePriceReview(this.policy.shopId,args.reviewId,args.key,args.decision,{confirmedSkuIds:args.confirmedSkuIds,acceptPriceAndRisk:args.acceptPriceAndRisk,historicalFingerprint:fingerprint(baseline)},this.now());
  }
  async preview() {
    requireThat(!this.running&&!this.busy,'BUSY','只读预查不能与守护任务并行');
    requireThat(this.platform.inventory?.activeComplete,'ACTIVE_UNKNOWN','全店有效活动尚未完整核对');
    const products=[],histories=this.latestHistories(),pending=this.journal.list(this.policy.shopId).filter(t=>!['verified','blocked'].includes(t.phase));
    for(const baseline of histories.values()){
      this.platform.check?.();
      const entry={productId:baseline.productId,name:baseline.name,campaignId:baseline.campaignId,historicalSkuCount:baseline.skus.length};
      try{
        if(this.policy.excludedProductIds?.includes(baseline.productId))entry.status='excluded';
        else if(pending.some(t=>t.plans.some(p=>p.productId===baseline.productId)))entry.status='pending';
        else {
          const loss=await this.platform.loss(baseline);requireThat(loss?.complete,'ACTIVE_UNKNOWN','当前活动读取不完整');
          if(loss.active)entry.status='active';
          else {
            const current=await this.platform.precheck(baseline),plan=this.restorePlan(baseline,current);
            Object.assign(entry,{status:'eligible',skuCount:plan.skus.length,skippedSkuIds:plan.skippedSkuIds,observedAt:current.observedAt});
          }
        }
      }catch(error){if(error.code==='STOPPED')throw error;Object.assign(entry,{status:'blocked',code:error.code||'READ_ERROR',message:String(error.message).slice(0,1000)});}
      products.push(entry);
      this.platform.progress={stage:'只读核对当前规格',read:products.length,total:histories.size,at:this.now()};
    }
    const result={readOnly:true,observedAt:this.now(),products};
    this.journal.putSettings('preview:'+this.policy.shopId,result);
    this.platform.progress={stage:'只读规格核对完成',read:products.length,total:histories.size,eligible:products.filter(p=>p.status==='eligible').length,blocked:products.filter(p=>p.status==='blocked').length,at:this.now()};
    return result;
  }
  async reconcile(task) {
    let observed=await this.platform.readback(task);
    if(!observed&&this.platform.resumeOriginalRisk&&await this.platform.resumeOriginalRisk(task,async proof=>{
      this.platform.assertWrite();this.journal.beginRiskConfirmation(task.id,proof,this.now());
    })){
      const current=this.journal.get(task.id);
      if(current.phase==='unknown')this.journal.transition(task.id,'unknown','verifying',{},this.now());
      observed=await this.platform.readback(this.journal.get(task.id));
    }
    if(!observed)return false;
    const receipt=proveReadback(task.plans,observed,{title:task.title,now:this.now()});
    const current=this.journal.get(task.id);
    const verified=this.journal.transition(task.id,current.phase,'verified',{receipt},this.now());
    if(!this.priorityWatch)this.priorityWatch=new PriorityWatch(this.journal,this.policy.shopId);
    for(const plan of verified.plans){this.priorityWatch.recordOne(plan.productId,receipt.campaignId,receipt.verifiedAt);this.journal.supersedePriceReviews(this.policy.shopId,plan.productId,'已独立回读有效活动',this.now());}
    this.priorityWatch.save();
    if(this.platform.release)await this.platform.release(verified).catch(()=>{});return true;
  }
  async execute(task) {
    let draft;const priceReviews=[];
    try {
      requireThat(!this.stopRequested,'STOPPED','运行已停止');
      this.journal.assertPricePlans(task.shopId,task.plans);
      draft=await this.platform.prepare(task);
      const proof=proveDraft(task,draft.observation,this.now());
      this.journal.transition(task.id,'queued','prepared',{preparedAt:this.now()},this.now());
      requireThat(!this.stopRequested,'STOPPED','运行已停止');
      await this.platform.submit(task,draft,async riskProof=>{
        requireThat(!this.stopRequested,'STOPPED','运行已停止');
        this.platform.assertWrite();
        this.journal.beginRiskConfirmation(task.id,riskProof,this.now());
      },async submitProof=>{
        this.platform.assertWrite();this.journal.beginSubmit(task.id,submitProof,this.now());
      });
      requireThat(this.journal.get(task.id).phase==='submitting','SUBMIT_NOT_RECORDED','平台适配器未记录提交边界');
      this.journal.transition(task.id,'submitting','verifying',{},this.now());
      if(!await this.reconcile(this.journal.get(task.id)))this.journal.transition(task.id,'verifying','unknown',{reason:'平台结果尚未回读确认'},this.now());
    }catch(error){
      if(error.code==='PRICE_REVIEW_REQUIRED'&&error.detail?.priceProbe){
        try{for(const review of makePriceReviews(task,error.detail.priceProbe,this.now()))priceReviews.push(this.journal.recordPriceReview(review,this.now(),{
          refreshPending:!!activePriceIncreaseGrant(this.journal,task.shopId,this.now())&&isAutomaticPriceIncrease(review)}));}
        catch(proposalError){error=proposalError;}
      }
      const current=this.journal.get(task.id),reason=`${error.code||'ERROR'}: ${String(error.message).slice(0,800)}`;
      if(this.platform.captureFailure)await this.platform.captureFailure(task,draft,current.phase,error).catch(()=>{});
      if(['queued','prepared'].includes(current.phase))this.journal.transition(task.id,current.phase,'blocked',{reason,retryAfter:this.now()+15*60000},this.now());
      else if(['submitting','verifying'].includes(current.phase))this.journal.transition(task.id,current.phase,'unknown',{reason},this.now());
      else this.journal.event(task.id,'readback-error',{reason},this.now());
      // Grant only an exact higher target after the old draft is recorded as
      // unsubmitted. The next attempt gets fresh loss, SKU and draft proofs.
      if(!this.stopRequested&&activePriceIncreaseGrant(this.journal,task.shopId,this.now()))for(const review of priceReviews){
        if(review.status!=='pending'||!isAutomaticPriceIncrease(review)||this.policy.excludedProductIds?.includes(review.productId))continue;
        try{
          const baseline=this.latestHistories().get(review.productId);requireThat(baseline,'PRICE_REVIEW_CHANGED','当前历史来源待核对');
          this.journal.approvePriceIncrease(task.shopId,review.id,review.key,fingerprint(baseline),this.now());
          this.priceIncreaseFollowups.add(review.productId);
        }catch(approvalError){this.journal.event(null,'price-increase-review-required',{shopId:task.shopId,productId:review.productId,code:approvalError.code,message:approvalError.message},this.now());}
      }
    }finally{if(this.platform.release)await this.platform.release(this.journal.get(task.id),draft).catch(()=>{});}
  }
  async recoverPriceIncreases(){
    if(!this.priceIncreaseFollowups.size)return false;
    let submitted=false;const latest=this.latestHistories();
    // One bounded pass prevents an unstable platform rule from causing a
    // price-adjustment loop. Durable exact targets survive a later restart.
    for(const productId of [...this.priceIncreaseFollowups].slice(0,5)){
      if(this.stopRequested)break;this.priceIncreaseFollowups.delete(productId);
      if(this.policy.excludedProductIds?.includes(productId)||this.journal.list(this.policy.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===productId)))continue;
      const baseline=latest.get(productId),target=this.journal.priceTarget(this.policy.shopId,productId);
      if(!baseline||target?.approvalKind!=='automatic-price-increase'||target.historicalFingerprint!==fingerprint(baseline))continue;
      try{
        const loss=await this.platform.loss(baseline,{fresh:true});
        requireThat(loss?.complete&&loss.observedAt>0&&this.now()-loss.observedAt<=120000,'LOSS_UNPROVEN','自动提价前尚未确认当前活动');
        if(loss.active){this.journal.clearProductCheck(this.policy.shopId,productId);continue;}
        const current=await this.platform.precheck(baseline),plan=this.restorePlan(baseline,current);
        checkRemovalPrices(plan,loss.removal);
        const proof={complete:true,observedAt:loss.observedAt,lossKey:fingerprint([loss.lossKey])};
        requireThat(loss.lossKey,'LOSS_UNPROVEN','自动提价缺少当前失效证明');
        let next=this.journal.enqueue(this.policy.shopId,[plan],proof,this.now());
        if(next.phase==='blocked'&&next.submitAttempts===0&&next.retryAfter<=this.now())next=this.journal.transition(next.id,'blocked','queued',{plans:[plan],lossEvidence:proof,reason:null},this.now());
        if(next.phase==='queued')await this.execute(next);
        const outcome=this.journal.get(next.id);submitted=submitted||outcome.submitAttempts>0;
        if(outcome.phase==='verified')this.journal.clearProductCheck(this.policy.shopId,productId);
      }catch(error){if(error.code==='STOPPED')throw error;this.journal.event(null,'price-increase-recovery-pending',{shopId:this.policy.shopId,productId,code:error.code,message:error.message},this.now());}
    }
    if(this.priceIncreaseFollowups.size||submitted)this.priorityResume=true;
    return submitted;
  }
  async recoverBatch(members,blocked){
    const observed=await readBatchProducts(this.platform,members),ready=[];
    for(const entry of observed){
      if(entry.error){blocked(entry.member,entry.error);continue;}
      try{ready.push({...entry.member,current:entry.current,plan:this.restorePlan(entry.member.baseline,entry.current)});}
      catch(error){blocked(entry.member,error);}
    }
    let submitted=false,differentActivity=false;
    // A price target or permitted missing SKU subset can change the final
    // discount group. Each final group gets new absence evidence at execution.
    for(const group of recoveryBatches(ready,{key:m=>restorationGroupKey(m.plan)})){
      if(this.stopRequested)break;
      let losses;
      try{
        losses=await this.platform.lossBatch(group.map(m=>m.baseline));
        requireThat(losses.length===group.length&&new Set(losses.map(r=>r.productId)).size===group.length&&
          losses.every(r=>group.some(m=>m.baseline.productId===r.productId)),'LOSS_UNPROVEN','批量失效证明商品集合不一致');
      }catch(error){
        if(error.code==='BATCH_PROOF_EXPIRED'&&group.length>1){
          const middle=Math.ceil(group.length/2);
          for(const part of [group.slice(0,middle),group.slice(middle)]){
            if(this.stopRequested)break;
            const result=await this.recoverBatch(part,blocked);
            submitted=submitted||result.submitted;differentActivity=differentActivity||result.differentActivity;
          }
        }else for(const member of group)blocked(member,error);
        continue;
      }
      const eligible=[];
      for(const member of group){
        const result=losses.find(r=>r.productId===member.baseline.productId);
        if(result.error){blocked(member,result.error);continue;}
        const loss=result.loss;
        try{
          requireThat(loss?.complete&&loss.observedAt>0&&this.now()-loss.observedAt<=120000&&loss.observedAt<=this.now()+5000,
            'LOSS_UNPROVEN','批量恢复缺少新鲜的独立失效证明');
          if(loss.active){
            requireThat(!loss.ambiguous,'ACTIVITY_AMBIGUOUS','商品的退出状态仍待核实');
            this.journal.clearProductCheck(this.policy.shopId,member.baseline.productId);
            this.journal.supersedePriceReviews(this.policy.shopId,member.baseline.productId,'当前商品已有有效活动',this.now());
            if(this.priorityWatch){this.priorityWatch.recordOne(member.baseline.productId,loss.campaignId,loss.observedAt);this.priorityWatch.save();}
            differentActivity=true;continue;
          }
          requireThat(loss.lossKey,'LOSS_UNPROVEN','失效标识缺失');
          eligible.push({...member,loss});
        }catch(error){blocked(member,error);}
      }
      const stale=eligible.filter(m=>this.now()-m.current.observedAt>30000||this.now()<m.current.observedAt);
      const refreshed=stale.length?await readBatchProducts(this.platform,stale):[];
      const plans=[],proofs=[];
      for(const member of eligible){
        try{
          const refresh=refreshed.find(r=>r.member.baseline.productId===member.baseline.productId);
          if(refresh?.error)throw refresh.error;
          const plan=this.restorePlan(member.baseline,refresh?.current||member.current);
          checkRemovalPrices(plan,member.loss.removal);
          requireThat(restorationGroupKey(plan)===restorationGroupKey(member.plan),'BATCH_CHANGED','刷新后的折扣组发生变化，等待重新分组');
          requireThat(this.now()-member.loss.observedAt<=120000,'LOSS_UNPROVEN','批量预查期间失效证明已过期');
          plans.push(plan);proofs.push(member.loss);
        }catch(error){blocked(member,error);}
      }
      if(!plans.length)continue;
      const lossEvidence={complete:true,observedAt:Math.min(...proofs.map(p=>p.observedAt)),lossKey:fingerprint(proofs.map(p=>p.lossKey))};
      let task=this.journal.enqueue(this.policy.shopId,plans,lossEvidence,this.now());
      if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=this.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence,reason:null},this.now());
      if(task.phase==='queued')await this.execute(task);
      task=this.journal.get(task.id);submitted=submitted||task.submitAttempts>0;
      for(const member of eligible.filter(m=>plans.some(p=>p.productId===m.baseline.productId))){
        if(task.phase==='verified')this.journal.clearProductCheck(this.policy.shopId,member.baseline.productId);
        else if(task.phase==='blocked')blocked(member,Object.assign(new Error(task.reason||'本批未提交'),{code:'RESTORE_BLOCKED'}));
      }
    }
    return{submitted,differentActivity};
  }
  async recoverPriorityBatch(hints){
    const latest=this.latestHistories(),checks=new Map(this.journal.productChecks(this.policy.shopId).map(c=>[c.productId,c]));
    const pending=new Set(this.journal.list(this.policy.shopId).filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId)));
    const members=[];
    for(const hint of hints){
      const baseline=latest.get(hint.productId),prior=checks.get(hint.productId);
      if(!baseline||pending.has(hint.productId)||this.policy.excludedProductIds?.includes(hint.productId))continue;
      if(prior?.contextKey===fingerprint(baseline)&&prior.retryAt>this.now()&&(!prior.watchKey||prior.watchKey===hint.watchKey))continue;
      members.push({baseline,hint});
    }
    const batch=recoveryBatches(members)[0];
    let result={submitted:false,differentActivity:false};
    if(batch?.length&&!this.stopRequested){
      await this.platform.closeMonitorPages?.();
      result=await this.recoverBatch(batch,(member,error)=>{
        if(error.code==='STOPPED')throw error;
        const {baseline,hint}=member;
        const detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:String(error.message).slice(0,1000),productState:error.detail?.productState};
        this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,watchKey:hint.watchKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+15*60000});
        this.journal.event(null,'product-blocked',detail,this.now());
      });
    }
    const changed=result.submitted||result.differentActivity;
    this.lastPriorityCheck={at:this.now(),hints:hints.length,inspected:batch?.length||0,submitted:result.submitted,refreshRequired:changed};
    return changed;
  }
  async recoverPriority(hints) {
    if(this.platform.precheckBatch&&this.platform.lossBatch)return this.recoverPriorityBatch(hints);
    const latest=this.latestHistories(),checks=new Map(this.journal.productChecks(this.policy.shopId).map(c=>[c.productId,c]));
    const pending=new Set(this.journal.list(this.policy.shopId).filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId)));
    const groups=new Map(),inspectionStarted=this.now();let inspected=0,changed=false,differentActivity=false;
    const blocked=(baseline,hint,error)=>{
      if(error.code==='STOPPED')throw error;
      const prior=checks.get(baseline.productId),detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:String(error.message).slice(0,1000),productState:error.detail?.productState};
      this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,watchKey:hint.watchKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+15*60000});
      if(prior?.code!==detail.code||prior?.watchKey!==hint.watchKey)this.journal.event(null,'product-blocked',detail,this.now());
    };
    for(const hint of hints){
      if(this.stopRequested)break;
      const baseline=latest.get(hint.productId);if(!baseline||pending.has(hint.productId)||this.policy.excludedProductIds?.includes(hint.productId))continue;
      const prior=checks.get(hint.productId);
      if(prior?.contextKey===fingerprint(baseline)&&prior.retryAt>this.now()&&(!prior.watchKey||prior.watchKey===hint.watchKey))continue;
      // Page latency must not make every early proof expire while collecting
      // later hints. Leave the rest for the next monitoring boundary.
      if(inspected>=5||inspected>0&&this.now()-inspectionStarted>=60000)break;
      if(inspected===0&&this.platform.closeMonitorPages)await this.platform.closeMonitorPages();
      inspected++;
      try{
        // The membership index only determines priority. It cannot authorize
        // absence, prices, SKU mappings or a submit.
        const loss=await this.platform.loss(baseline,{fresh:true});
        requireThat(loss?.complete===true,'LOSS_UNPROVEN','优先恢复前未能完整核对当前活动');
        if(loss.active){
          requireThat(!loss.ambiguous,'ACTIVITY_AMBIGUOUS','商品在当前活动中的退出状态仍待核实');
          this.journal.supersedePriceReviews(this.policy.shopId,baseline.productId,'当前商品已有有效活动',this.now());
          differentActivity=differentActivity||!this.priorityListing.campaigns.some(c=>c.id===loss.campaignId);
          this.priorityWatch.recordOne(baseline.productId,loss.campaignId,loss.observedAt);this.priorityWatch.save();this.journal.clearProductCheck(this.policy.shopId,baseline.productId);continue;
        }
        requireThat(loss.lossKey&&loss.observedAt>0&&this.now()-loss.observedAt<=120000,'LOSS_UNPROVEN','优先恢复缺少新鲜的独立失效证明');
        const current=await this.platform.precheck(baseline),plan=this.restorePlan(baseline,current);
        checkRemovalPrices(plan,loss.removal);
        const key=restorationGroupKey(plan);if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push({baseline,hint,loss,plan});
      }catch(error){blocked(baseline,hint,error);}
    }
    for(const members of groups.values()){
      if(this.stopRequested)break;
      try{
        requireThat(members.every(m=>this.now()-m.plan.observedAt<=120000&&this.now()-m.loss.observedAt<=120000),'PROOF_EXPIRED','优先恢复的逐商品证据已过期');
        const plans=members.map(m=>m.plan),lossEvidence={complete:true,observedAt:Math.min(...members.map(m=>m.loss.observedAt)),lossKey:fingerprint(members.map(m=>m.loss.lossKey))};
        let task=this.journal.enqueue(this.policy.shopId,plans,lossEvidence,this.now());
        if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=this.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence,reason:null},this.now());
        if(task.phase==='queued')await this.execute(task);
        task=this.journal.get(task.id);changed=changed||task.submitAttempts>0;
        if(task.phase==='verified'){
          for(const member of members){this.journal.clearProductCheck(this.policy.shopId,member.plan.productId);this.priorityWatch.recordOne(member.plan.productId,task.receipt.campaignId,task.receipt.verifiedAt);}
          this.priorityWatch.save();
        }else if(task.phase==='blocked')for(const member of members)blocked(member.baseline,member.hint,Object.assign(new Error(task.reason||'优先恢复未提交'),{code:'RESTORE_BLOCKED'}));
      }catch(error){for(const member of members)blocked(member.baseline,member.hint,error);}
    }
    this.lastPriorityCheck={at:this.now(),hints:hints.length,inspected,submitted:changed,refreshRequired:changed||differentActivity};return changed||differentActivity;
  }
  beginPriorityPoll() {
    if(this.priorityPoll||!this.priorityListing||this.stopRequested||this.now()-this.lastPriorityPoll<30000)return;
    this.lastPriorityPoll=this.now();
    // This promise performs reads only. Its result is consumed after both
    // detail readers have closed, before any priority recovery can write.
    this.priorityPoll=Promise.resolve().then(()=>this.platform.peekActive?this.platform.peekActive():this.platform.listActive())
      .then(listing=>({listing}),error=>({error}));
  }
  async settlePriorityPoll() {
    const pending=this.priorityPoll;if(!pending)return null;
    try{return await pending;}finally{if(this.priorityPoll===pending)this.priorityPoll=null;}
  }
  async checkPriority({listing,reads,deferListPoll=false}) {
    requireThat(!this.stopRequested,'STOPPED','后台写入已停止');
    if(!this.priorityWatch)this.priorityWatch=new PriorityWatch(this.journal,this.policy.shopId);
    if(!this.priorityListing){this.priorityListing=listing;this.lastPriorityPoll=this.now();}
    for(const {campaign,detail} of reads.filter(r=>['进行中','未开始'].includes(r.campaign.status))){
      this.priorityWatch.observe(campaign,detail);
      for(const p of detail.products)if(!p.removalConfirmed&&!p.removalAmbiguous)this.journal.clearProductCheck(this.policy.shopId,p.productId);
    }
    if(!deferListPoll)this.beginPriorityPoll();
    const polled=await this.settlePriorityPoll();
    if(polled?.error){
      const error=polled.error;if(error.code==='STOPPED')throw error;
      this.journal.event(null,'priority-read-pending',{shopId:this.policy.shopId,code:error.code||'READ_ERROR',message:String(error.message).slice(0,1000)},this.now());
    }
    else if(polled)this.priorityListing=polled.listing;
    const hints=this.priorityWatch.hints(this.priorityListing);
    let changed=await this.recoverPriority(hints);
    changed=await this.recoverPriceIncreases()||changed;
    if(changed||currentListingKey(listing)!==currentListingKey(this.priorityListing))return{refreshRequired:true,listing:this.priorityListing};
    this.platform.refreshCurrentEvidence?.(this.priorityListing);
    return null;
  }
  async priorityPlanningBoundary(){
    if(!this.priorityListing||this.now()-this.lastPriorityPoll<30000)return false;
    const result=await this.checkPriority({listing:this.platform.inventory?.listing||this.priorityListing,reads:[]});
    if(!result?.refreshRequired)return false;
    this.platform.invalidateInventory?.(result.listing);this.priorityResume=true;return true;
  }
  async tick() {
    requireThat(this.policy.liveEnabled===true&&this.policy.cutoverConfirmed===true,'CUTOVER_REQUIRED','新程序尚未启用实店执行');
    const conversion=this.journal.settings('campaign-conversion:'+this.policy.shopId);
    requireThat(!conversion||conversion.status==='complete','CONVERSION_IN_PROGRESS','活动迁移尚未完成，保留原始记录并暂停普通巡检');
    if(this.busy)return {skipped:'busy'};
    this.journal.lease(this.policy.shopId,this.owner,this.now());this.busy=true;this.priorityResume=false;this.priorityListing=null;
    let leaseError=null;
    const heartbeat=setInterval(()=>{try{this.journal.lease(this.policy.shopId,this.owner,this.now());}catch(error){leaseError=error;this.stopRequested=true;}},20000);
    const startedAt=this.now();
    try{
      if(!this.recovered){this.journal.recoverInterrupted(this.policy.shopId);this.recovered=true;}
      for(const task of this.journal.list(this.policy.shopId).filter(t=>['unknown','verifying'].includes(t.phase))){
        if(this.stopRequested)break;
        try{await this.reconcile(task);}catch(error){this.journal.event(task.id,'verification-pending',{code:error.code||'ERROR',message:error.message},this.now());}
      }
      if(this.stopRequested)return;
      this.nextAt=null;
      const historyReadLimit=this.policy.captureExistingOnly?0:!this.journal.histories(this.policy.shopId).length?20:this.now()-this.lastHistoryRead>=15*60000?2:0;
      const discovery=await this.platform.discover({historyReadLimit,...(this.platform.listActive?{onReadBatchStart:()=>this.beginPriorityPoll(),onReadBoundary:context=>this.checkPriority(context)}:{})});if(historyReadLimit)this.lastHistoryRead=this.now();
      for(const baseline of discovery.baselines||[])this.journal.remember(baseline,this.now());
      if(discovery.priorityRefreshRequired){this.priorityResume=true;return{priorityRefreshRequired:true};}
      requireThat(discovery.activeComplete===true,'ACTIVE_UNKNOWN','全店有效活动尚未完整核对，暂停本轮新建');
      const latest=this.latestHistories();
      const groups=new Map(),candidates=[],checks=new Map(this.journal.productChecks(this.policy.shopId).map(c=>[c.productId,c]));
      const blocked=(baseline,loss,error)=>{
        if(error.code==='STOPPED')throw error;
        const detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:error.message,productState:error.detail?.productState};
        this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,lossKey:loss?.lossKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+15*60000});
        this.journal.event(null,'product-blocked',detail,this.now());
      };
      for(const baseline of latest.values()){
        if(this.stopRequested)break;
        if(this.policy.excludedProductIds?.includes(baseline.productId))continue;
        if(this.journal.list(this.policy.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===baseline.productId)))continue;
        try{
          const loss=await this.platform.loss(baseline);if(!loss?.complete)continue;
          if(loss.active){this.journal.clearProductCheck(this.policy.shopId,baseline.productId);if(!loss.ambiguous)this.journal.supersedePriceReviews(this.policy.shopId,baseline.productId,'当前商品已有有效活动',this.now());continue;}
          const prior=checks.get(baseline.productId),same=prior?.lossKey===loss.lossKey&&prior?.contextKey===fingerprint(baseline);
          if(same&&prior.retryAt>this.now())continue;
          candidates.push({baseline,loss,retry:same,priorAt:prior?.at||0});
        }catch(error){blocked(baseline,null,error);}
      }
      if(this.platform.precheckBatch&&this.platform.lossBatch){
        let retries=0;
        const eligible=candidates.sort((a,b)=>Number(a.retry)-Number(b.retry)||a.priorAt-b.priorAt).filter(c=>!c.retry||retries++<3);
        for(const batch of recoveryBatches(eligible)){
          if(this.stopRequested)break;
          if(await this.priorityPlanningBoundary())return{priorityRefreshRequired:true};
          await this.recoverBatch(batch,(member,error)=>blocked(member.baseline,member.loss,error));
        }
      }else{
      let retries=0;
      for(const {baseline,loss,retry} of candidates.sort((a,b)=>Number(a.retry)-Number(b.retry)||a.priorAt-b.priorAt)){
        if(this.stopRequested)break;if(retry&&retries++>=3)continue;
        if(await this.priorityPlanningBoundary())return{priorityRefreshRequired:true};
        try{
          const current=await this.platform.precheck(baseline);
          const plan=this.restorePlan(baseline,current);
          this.journal.clearProductCheck(this.policy.shopId,baseline.productId);
          const key=restorationGroupKey(plan);if(!groups.has(key))groups.set(key,[]);
          groups.get(key).push({plan,loss,current:structuredClone(current)});
        }catch(error){blocked(baseline,loss,error);}
      }
      for(const group of groups.values())for(let start=0;start<group.length;){
        if(this.stopRequested)break;
        if(await this.priorityPlanningBoundary())return{priorityRefreshRequired:true};
        // Recheck expiry at execution time. A large store cannot use probes
        // gathered many minutes earlier to authorize a later price write.
        const plans=[],losses=[],batchStarted=this.now();let read=0;
        while(start<group.length&&read<5&&(read===0||this.now()-batchStarted<60000)){
          const member=group[start++];read++;
          try{
            const baseline=latest.get(member.plan.productId),loss=await this.platform.loss(baseline,{fresh:true});
            requireThat(loss?.complete===true&&!loss.active&&loss.lossKey,'LOSS_UNPROVEN','提交前未能确认商品当前无有效活动');
            // A just-completed full SKU read can survive the separate absence
            // query. Keep its real observation time; older reads use a new page.
            // prepare/submit still independently prove exact draft contents.
            const age=this.now()-(member.current?.observedAt||0);
            const current=member.current&&age>=0&&age<=30000?member.current:await this.platform.precheck(baseline);
            const plan=this.restorePlan(baseline,current);checkRemovalPrices(plan,loss.removal);
            plans.push(plan);losses.push(loss);
          }catch(error){this.journal.event(null,'product-blocked',{productId:member.plan.productId,code:error.code||'ERROR',message:error.message},this.now());}
        }
        if(!plans.length)continue;
        requireThat(plans.every(p=>this.now()-p.observedAt<=120000),'PROOF_EXPIRED','本批预查已过期');
        const lossEvidence={complete:true,observedAt:Math.min(...losses.map(loss=>loss.observedAt)),lossKey:fingerprint(losses.map(loss=>loss.lossKey))};
        let task=this.journal.enqueue(this.policy.shopId,plans,lossEvidence,this.now());
        if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=this.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence,reason:null},this.now());
        if(task.phase==='queued')await this.execute(task);
      }
      }
      await this.recoverPriceIncreases();
      if(leaseError)throw leaseError;
      requireThat(!this.stopRequested,'STOPPED','本轮巡检已暂停，尚未完成');
      this.recordRun({startedAt,finishedAt:this.now(),ok:true});
    }catch(error){this.recordRun({startedAt,finishedAt:this.now(),ok:false,code:error.code||'ERROR',message:String(error.message).slice(0,1000)});}
    finally{
      // A stop or failed detail read must also drain the read-only monitor;
      // otherwise the next shop, maintenance handoff or write could overlap it.
      await this.settlePriorityPoll();clearInterval(heartbeat);this.journal.release(this.policy.shopId,this.owner);this.busy=false;
    }
    return this.status();
  }
  start() {
    requireThat(this.policy.liveEnabled&&this.policy.cutoverConfirmed,'CUTOVER_REQUIRED','首次切换尚未确认');
    if(this.running)return;this.running=true;this.stopRequested=false;
    const run=async()=>{
      if(!this.running)return;const started=this.now();
      try{await this.tick();}catch(error){const at=this.now();this.recordRun({ok:false,startedAt:at,finishedAt:at,code:error.code||'ERROR',message:error.message});}
      if(this.running){
        const completed=this.lastRun?.ok===true&&this.lastRun.startedAt>=started&&this.lastRun.finishedAt>=started;
        // Long scans already space reads out. Retain a ten-second idle window
        // for the desktop's five-second maintenance check, a thirty-second
        // start cadence for small shops, and the existing failure backoff.
        const delay=this.priorityResume?1000:completed?Math.max(10000,30000-Math.max(0,this.now()-started)):60000;
        this.nextAt=this.now()+delay;this.timer=setTimeout(run,delay);
      }
    };
    this.timer=setTimeout(run,0);
  }
  stop() {this.running=false;this.stopRequested=true;this.nextAt=null;clearTimeout(this.timer);}
}
