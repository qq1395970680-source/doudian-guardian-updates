import {randomUUID} from 'node:crypto';
import {planOriginalRestore,proveDraft,proveReadback,fingerprint,requireThat,restorationGroupKey} from './policy.mjs';
import {preferCampaignBaselines,applyCampaignPolicy} from './campaign-policy.mjs';
import {PriorityWatch,currentListingKey} from './priority-watch.mjs';
import {applyPriceTarget,makePriceReviews} from './price-review.mjs';
import {activePriceIncreaseGrant,isAutomaticPriceIncrease} from './price-increase-policy.mjs';
import {recoveryBatches,readBatchProducts} from './recovery-batches.mjs';
import {checkRemovalPrices} from './removal-export.mjs';
import {isolateDraftPriceFailure} from './draft-price-isolation.mjs';
import {assertRecoveryCapacity} from './recovery-capacity.mjs';
import {recoveryRequests,requestRecovery,updateRecoveryRequest,pauseRecoveryRequests} from './recovery-requests.mjs';

const displayRun=(run,now)=>run&&typeof run.ok==='boolean'&&Number.isFinite(run.startedAt)&&Number.isFinite(run.finishedAt)&&run.startedAt>0&&run.finishedAt>=run.startedAt&&run.finishedAt<=now+5000?
 {startedAt:run.startedAt,finishedAt:run.finishedAt,ok:run.ok,...(run.code?{code:String(run.code).slice(0,80)}:{}),...(run.message?{message:String(run.message).slice(0,1000)}:{})}:null;
const unavailableProduct=code=>['PRODUCT_RECYCLED','OFF_SHELF'].includes(code);
const blockerDelay=code=>unavailableProduct(code)?86400000:15*60000;
// Confirmed unavailable products only need a daily state recheck. A positive
// current activity clears the check; a changed baseline also bypasses it.
const knownBlockerCoolingDown=(prior,baseline,now)=>prior?.contextKey===fingerprint(baseline)&&
 ['PRODUCT_RECYCLED','OFF_SHELF','SKU_RATIO_REVIEW_REQUIRED','RESTORE_SKU_BUDGET'].includes(prior.code)&&
 Math.max(prior.retryAt||0,unavailableProduct(prior.code)?(prior.at||0)+blockerDelay(prior.code):0)>now;
const lossEvidenceFor=losses=>({complete:true,observedAt:Math.min(...losses.map(l=>l.observedAt)),
 lossKey:fingerprint(losses.map(l=>l.lossKey)),
 ...(losses.some(l=>l.continuity)?{continuities:losses.filter(l=>l.continuity).map(l=>structuredClone(l.continuity))}:{}),
 ...(losses.some(l=>l.removalEvidence)?{priceRules:losses.filter(l=>l.removalEvidence).map(l=>structuredClone(l))}:{})});

export class GuardianService {
  constructor({journal,platform,policy,now=()=>Date.now(),immediate=false}) {
    this.journal=journal;this.platform=platform;this.policy=policy;this.now=now;this.owner=randomUUID();
    this.running=false;this.busy=false;this.timer=null;this.lastRun=null;this.lastSuccessfulRun=null;this.nextAt=null;this.stopRequested=false;
    const patrol=policy.shopId?journal.settings('patrol-display:'+policy.shopId):null;
    if(patrol?.schema===1&&patrol.shopId===policy.shopId&&patrol.source==='completed-program-patrol'){
      this.lastRun=displayRun(patrol.lastRun,this.now());const success=displayRun(patrol.lastSuccessfulRun,this.now());this.lastSuccessfulRun=success?.ok?success:null;
    }
    this.recovered=false;this.lastHistoryRead=this.now();
    this.priceIncreaseFollowups=new Set();
    this.priorityWatch=null;this.priorityListing=null;this.lastPriorityPoll=0;this.priorityPoll=null;this.priorityResume=false;this.lastPriorityCheck=null;
    this.immediateEnabled=immediate;this.immediateTimer=null;this.immediatePromise=null;
    this.platform.assertWrite=()=>{requireThat(!this.stopRequested&&this.policy.liveEnabled&&this.policy.cutoverConfirmed,'STOPPED','后台写入已停止');
      const health=this.platform.readHealth?.();requireThat(!health?.quarantined&&!health?.active?.length,'READS_PENDING','只读页面尚未完成清理，暂停提交');
      this.journal.assertLease(this.policy.shopId,this.owner,this.now());};
  }
  status() {
    const tasks=this.policy.shopId?this.journal.list(this.policy.shopId):[];
    const direct=this.immediateEnabled&&this.policy.shopId?recoveryRequests(this.journal,this.policy.shopId):null;
    return {shopId:this.policy.shopId,running:this.running,busy:this.busy,nextAt:this.nextAt,patrolStartedAt:this.patrolStartedAt||null,lastRun:this.lastRun,lastSuccessfulRun:this.lastSuccessfulRun,lastPriorityCheck:this.lastPriorityCheck,
      verified:tasks.filter(t=>t.phase==='verified').reduce((n,t)=>n+t.plans.length,0),unknown:tasks.filter(t=>['submitting','unknown','verifying'].includes(t.phase)).length,
      blocked:tasks.filter(t=>t.phase==='blocked').length,
      immediateRecovery:direct?{pending:direct.items.filter(r=>r.state==='pending').length,deferred:direct.items.filter(r=>r.state==='deferred').length,paused:direct.paused}:null,
      readHealth:this.platform.readHealth?.()||null,
      tasks:tasks.slice(0,100).map(t=>({id:t.id,title:t.title,phase:t.phase,products:t.plans.map(p=>p.productId),updatedAt:t.updatedAt,reason:t.reason||null,receipt:t.receipt||null}))};
  }
  recordRun(run){
    this.lastRun=run;if(run.ok)this.lastSuccessfulRun=run;
    if(run.code==='LOGIN_REQUIRED')this.onAuthenticationFailure?.(run);
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
    const review=this.journal.priceTarget(this.policy.shopId,baseline.productId);
    let source=baseline;
    // Adding the previously unrecorded timed duration must not discard exact
    // price/type consent for the very same immutable campaign and SKU history.
    if(review?.status==='approved'&&review.historicalFingerprint!==fingerprint(baseline)&&baseline.durationMs!=null){
      const prior=this.journal.histories(this.policy.shopId).find(b=>fingerprint(b)===review.historicalFingerprint);
      const withoutDuration=b=>{const {observedAt,durationMs,...rest}=b;return fingerprint(rest);};
      if(prior&&prior.durationMs==null&&withoutDuration(prior)===withoutDuration(baseline))source=prior;
    }
    let plan=planOriginalRestore(source,current,this.policy,this.now());
    if(source!==baseline){const {fingerprint:previous,...body}=plan;plan={...body,durationMs:baseline.durationMs};plan.fingerprint=fingerprint(plan);}
    try{const result=applyCampaignPolicy(applyPriceTarget(plan,review),this.journal);assertRecoveryCapacity([result]);return result;}
    catch(error){
      if(error.code!=='PRICE_APPROVAL_CHANGED')throw error;
      const proposal=this.journal.recordPriceReconfirmation(applyCampaignPolicy(plan,this.journal),this.now());
      throw Object.assign(new Error(proposal.status==='declined'?'旧确认金额已失效；已保留暂不调整选择，可在价格确认页重新核对。':'旧确认金额与当前取整规则不一致，请在价格确认页核对新金额并重新确认。'),
        {code:'PRICE_RECONFIRM_REQUIRED',reviewId:proposal.id});
    }
  }
  checkPriceRules(plan,loss){
    // Another activity's removal rule is evidence of that activity's loss,
    // not proof that a newly selected type accepts or rejects these prices.
    // The fresh target-type draft must still pass every price/rule check.
    if(plan.campaignTarget&&loss.removalEvidence?.activityType&&loss.removalEvidence.activityType!==plan.type)return;
    try{checkRemovalPrices(plan,loss.removal);}
    catch(error){
      if(error.code==='SKU_RATIO_REVIEW_REQUIRED'){
        try{this.journal.recordRemovalPriceReview(plan,loss,this.now());}
        catch(proposalError){this.journal.event(null,'price-review-unavailable',{shopId:plan.shopId,productId:plan.productId,
          code:proposalError.code||'ERROR',message:String(proposalError.message).slice(0,1000)},this.now());}
      }
      throw error;
    }
  }
  decidePriceReview(args) {
    const review=this.journal.priceReview(args.reviewId),baseline=review&&this.latestHistories().get(review.productId);
    requireThat(review?.shopId===this.policy.shopId&&baseline&&!this.policy.excludedProductIds?.includes(review.productId),'PRICE_REVIEW_CHANGED','店铺、历史或排除设置已变化');
    const result=this.journal.decidePriceReview(this.policy.shopId,args.reviewId,args.key,args.decision,{confirmedSkuIds:args.confirmedSkuIds,acceptPriceAndRisk:args.acceptPriceAndRisk,historicalFingerprint:fingerprint(baseline),optionId:args.optionId??null,optionKey:args.optionKey??null,confirmRebuild:args.confirmRebuild===true,queueRecovery:this.immediateEnabled},this.now());
    if(this.immediateEnabled&&['approve','recalculate'].includes(args.decision)){
      if(this.policy.liveEnabled&&this.policy.cutoverConfirmed&&this.policy.originalRiskAllowed){
        if(this.busy&&this.stopRequested)this.requestedResume=true;else{this.stopRequested=false;this.platform.stopping=false;}
        this.wakeImmediate();
      }else pauseRecoveryRequests(this.journal,this.policy.shopId,true);
    }
    return result;
  }
  requestRecovery(productIds,{reason='user-recheck',approvalId=null}={}){
    requireThat(this.policy.liveEnabled&&this.policy.cutoverConfirmed&&this.policy.originalRiskAllowed,'CUTOVER_REQUIRED','请先确认本店原折扣守护规则');
    const histories=this.latestHistories();
    requireThat(productIds.length>0&&productIds.length<=10000&&new Set(productIds).size===productIds.length&&
      productIds.every(productId=>histories.has(productId)&&!this.policy.excludedProductIds?.includes(productId)),
      'RECOVERY_SCOPE','请核对商品历史和排除设置');
    requestRecovery(this.journal,this.policy.shopId,productIds.map(productId=>({productId,approvalId})),reason,this.now());
    if(this.busy&&this.stopRequested)this.requestedResume=true;
    else{this.stopRequested=false;this.platform.stopping=false;}
    this.wakeImmediate();return{queued:productIds.length};
  }
  wakeImmediate(){
    if(!this.policy.shopId||!this.policy.liveEnabled||!this.policy.cutoverConfirmed||!this.policy.originalRiskAllowed||!this.immediateEnabled||this.stopRequested||this.busy||this.immediatePromise||this.immediateTimer||this.canRunImmediate?.()===false)return;
    const queue=recoveryRequests(this.journal,this.policy.shopId),due=queue.items.filter(r=>r.state==='pending');
    if(queue.paused||!due.length)return;
    const wait=Math.max(0,Math.min(...due.map(r=>r.retryAt||0))-this.now());
    this.immediateTimer=setTimeout(()=>{this.immediateTimer=null;void this.runImmediate().catch(error=>{
      this.journal.event(null,'priority-recovery-error',{shopId:this.policy.shopId,code:error.code||'ERROR',message:error.message},this.now());
    });},wait);this.immediateTimer.unref?.();
  }
  async recoverRequested(){
    const queue=recoveryRequests(this.journal,this.policy.shopId),due=queue.items.filter(r=>r.state==='pending'&&(r.retryAt||0)<=this.now());
    if(queue.paused||!due.length||this.stopRequested)return{submitted:false,processed:0};
    await this.settlePriorityPoll();await this.platform.closeMonitorPages?.();
    const latest=this.latestHistories(),members=[],attempts=new Map(),requests=new Map(due.map(r=>[r.productId,r]));
    for(const request of due){
      const baseline=latest.get(request.productId);
      if(!baseline||this.policy.excludedProductIds?.includes(request.productId)){
        updateRecoveryRequest(this.journal,this.policy.shopId,request,{state:'deferred',reason:'商品历史或排除设置已变化'},this.now());continue;
      }
      const pending=this.journal.list(this.policy.shopId).filter(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===request.productId));
      if(pending.length){
        for(const t of pending)if(['unknown','verifying'].includes(t.phase))try{await this.reconcile(t);}catch(error){this.journal.event(t.id,'verification-pending',{code:error.code,message:error.message},this.now());}
        const unresolved=this.journal.list(this.policy.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===request.productId));
        updateRecoveryRequest(this.journal,this.policy.shopId,request,unresolved?{state:'pending',retryAt:this.now()+10000,reason:'已有提交只回读核实'}:{state:'complete',reason:'已有任务已独立核实'},this.now());continue;
      }
      members.push({baseline,loss:{complete:false},request});
    }
    let submitted=false,refreshRequired=false;
    const blocked=(member,error)=>{
      attempts.set(member.baseline.productId,error);
      const detail={shopId:this.policy.shopId,productId:member.baseline.productId,code:error.code||'ERROR',message:error.message,
        productState:error.detail?.productState,precheckMembership:error.detail?.precheckMembership,restoreCapacity:error.detail?.restoreCapacity,limitedLoss:error.detail?.limitedLoss};
      this.journal.putProductCheck(this.policy.shopId,detail.productId,{...detail,contextKey:fingerprint(member.baseline),at:this.now(),retryAt:this.now()+blockerDelay(detail.code)});
      this.journal.event(null,'product-blocked',detail,this.now());
    };
    for(const batch of recoveryBatches(members)){
      if(this.stopRequested)break;
      const result=await this.recoverBatch(batch,blocked);submitted=submitted||result.submitted;refreshRequired=refreshRequired||result.differentActivity;
      for(const member of batch){
        if(this.stopRequested)break;const request=requests.get(member.baseline.productId),error=attempts.get(member.baseline.productId);
        const pending=this.journal.list(this.policy.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===member.baseline.productId));
        const retry=error&&['LOAD_TIMEOUT','READ_OPERATION_TIMEOUT','BATCH_PROOF_EXPIRED','ACTIVE_CHANGED','ACTIVE_UNKNOWN'].includes(error.code);
        updateRecoveryRequest(this.journal,this.policy.shopId,request,pending?{state:'pending',retryAt:this.now()+10000,reason:'提交结果待回读'}:
          error?{state:retry?'pending':'deferred',retryAt:this.now()+15000,reason:error.message}:{state:'complete',reason:'当前有效活动或恢复结果已核实'},this.now());
      }
    }
    return{submitted,refreshRequired,processed:due.length};
  }
  async runImmediate({atBoundary=false}={}){
    if(this.busy||this.stopRequested||!this.immediateEnabled||!atBoundary&&this.canRunImmediate?.()===false)return{submitted:false,processed:0};
    requireThat(this.policy.liveEnabled&&this.policy.cutoverConfirmed&&this.policy.originalRiskAllowed,'CUTOVER_REQUIRED','本店守护规则尚未确认');
    if(this.immediatePromise)return this.immediatePromise;
    const run=(async()=>{
      this.journal.lease(this.policy.shopId,this.owner,this.now());this.busy=true;
      let leaseError=null;
      const heartbeat=setInterval(()=>{try{this.journal.lease(this.policy.shopId,this.owner,this.now());}catch(error){leaseError=error;this.stopRequested=true;}},20000);heartbeat.unref?.();
      try{
        if(!this.recovered){this.journal.recoverInterrupted(this.policy.shopId,this.now());this.recovered=true;}
        await this.settlePriorityPoll();await this.platform.closeMonitorPages?.();
        const result=await this.recoverRequested();if(leaseError)throw leaseError;return result;
      }finally{
        if(this.platform.readHealth?.().quarantined){this.cleanupHeartbeat=heartbeat;this.running=false;this.nextAt=null;}
        else{clearInterval(heartbeat);this.journal.release(this.policy.shopId,this.owner);this.busy=false;}
      }
    })();
    this.immediatePromise=run;try{return await run;}
    catch(error){
      const queue=recoveryRequests(this.journal,this.policy.shopId);
      for(const request of queue.items.filter(r=>r.state==='pending'&&(r.retryAt||0)<=this.now()))updateRecoveryRequest(this.journal,this.policy.shopId,request,{state:'pending',retryAt:this.now()+15000,reason:error.message},this.now());
      throw error;
    }finally{
      this.immediatePromise=null;
      if(!this.busy&&this.requestedResume&&!recoveryRequests(this.journal,this.policy.shopId).paused){this.requestedResume=false;this.stopRequested=false;this.platform.stopping=false;}
      this.wakeImmediate();
    }
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
    const receipt=proveReadback(task.plans,observed,{title:task.title,now:this.now(),
      expectedRange:task.plans.some(p=>p.durationMs!=null)?task.draftProof?.observation:null});
    const current=this.journal.get(task.id);
    const verified=this.journal.transition(task.id,current.phase,'verified',{receipt},this.now());
    if(!this.priorityWatch)this.priorityWatch=new PriorityWatch(this.journal,this.policy.shopId);
    for(const plan of verified.plans){this.priorityWatch.recordOne(plan.productId,receipt.campaignId,receipt.verifiedAt);this.journal.supersedePriceReviews(this.policy.shopId,plan.productId,'已独立回读有效活动',this.now());}
    this.priorityWatch.save();
    if(this.platform.refreshAfterReadback)try{await this.platform.refreshAfterReadback(verified,observed);}catch(error){this.journal.event(task.id,'post-restore-catalog-pending',{shopId:task.shopId,code:error.code||'ERROR',message:error.message},this.now());}
    if(this.platform.release)await this.platform.release(verified).catch(()=>{});return true;
  }
  async execute(task) {
    let draft,priceFailure=null;const priceReviews=[];
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
        try{
          const validatedAt=this.now(),probe=structuredClone(error.detail.priceProbe);
          for(const review of makePriceReviews(task,probe,validatedAt))priceReviews.push(this.journal.recordPriceReview(review,this.now(),{
            refreshPending:!!activePriceIncreaseGrant(this.journal,task.shopId,this.now())&&isAutomaticPriceIncrease(review)}));
          priceFailure={code:error.code,taskId:task.id,shopId:task.shopId,plansFingerprint:fingerprint(task.plans),probe,validatedAt,
            recordedReviews:priceReviews.map(({id,key,shopId,productId})=>({id,key,shopId,productId}))};
        }
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
      return {error,priceFailure};
    }finally{if(this.platform.release)await this.platform.release(this.journal.get(task.id),draft).catch(()=>{});}
  }
  async recoverPriceIncreases(){
    if(!this.priceIncreaseFollowups.size)return false;
    let submitted=false;const latest=this.latestHistories(),members=[];
    const pending=new Set(this.journal.list(this.policy.shopId).filter(t=>!['verified','blocked'].includes(t.phase)).flatMap(t=>t.plans.map(p=>p.productId)));
    // Snapshot once: a newly observed higher floor is a separate recheck,
    // never a recursive price-adjustment loop in this pass. Work not reached
    // before a stop stays queued; exact approved targets also survive restart.
    for(const productId of [...this.priceIncreaseFollowups]){
      const baseline=latest.get(productId),target=this.journal.priceTarget(this.policy.shopId,productId);
      if(this.policy.excludedProductIds?.includes(productId)||pending.has(productId)||!baseline||target?.status!=='approved'||
        target.approvalKind!=='automatic-price-increase'||target.historicalFingerprint!==fingerprint(baseline)){
        this.priceIncreaseFollowups.delete(productId);continue;
      }
      members.push({baseline});
    }
    const blocked=(member,error)=>{
      if(error.code==='STOPPED')throw error;
      const productId=member.baseline.productId,detail={shopId:this.policy.shopId,productId,code:error.code||'ERROR',message:String(error.message).slice(0,1000),restoreCapacity:error.detail?.restoreCapacity,limitedLoss:error.detail?.limitedLoss};
      this.journal.putProductCheck(this.policy.shopId,productId,{...detail,lossKey:member.loss?.lossKey,contextKey:fingerprint(member.baseline),at:this.now(),retryAt:this.now()+blockerDelay(detail.code)});
      this.journal.event(null,'price-increase-recovery-pending',detail,this.now());
    };
    if(this.platform.precheckBatch&&this.platform.lossBatch){
      for(const batch of recoveryBatches(members)){
        if(this.stopRequested)break;
        for(const member of batch)this.priceIncreaseFollowups.delete(member.baseline.productId);
        const result=await this.recoverBatch(batch,blocked);submitted=submitted||result.submitted;
      }
    }else for(const member of members){
      if(this.stopRequested)break;
      const {baseline}=member,productId=baseline.productId;this.priceIncreaseFollowups.delete(productId);
      try{
        const loss=await this.platform.loss(baseline,{fresh:true});
        requireThat(loss?.complete&&loss.observedAt>0&&this.now()-loss.observedAt<=120000,'LOSS_UNPROVEN','自动提价前尚未确认当前活动');
        if(loss.active){this.journal.clearProductCheck(this.policy.shopId,productId);continue;}
        const current=await this.platform.precheck(baseline),plan=this.restorePlan(baseline,current);
        this.checkPriceRules(plan,loss);
        const proof=lossEvidenceFor([loss]);
        requireThat(loss.lossKey,'LOSS_UNPROVEN','自动提价缺少当前失效证明');
        let next=this.journal.enqueue(this.policy.shopId,[plan],proof,this.now());
        if(next.phase==='blocked'&&next.submitAttempts===0&&next.retryAfter<=this.now())next=this.journal.transition(next.id,'blocked','queued',{plans:[plan],lossEvidence:proof,reason:null},this.now());
        if(next.phase==='queued')await this.execute(next);
        const outcome=this.journal.get(next.id);submitted=submitted||outcome.submitAttempts>0;
        if(outcome.phase==='verified')this.journal.clearProductCheck(this.policy.shopId,productId);
      }catch(error){blocked(member,error);}
    }
    if(this.priceIncreaseFollowups.size||submitted)this.priorityResume=true;
    return submitted;
  }
  async recoverBatch(members,blocked,{capacityRetry=0,priceIsolationDepth=0}={}){
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
            const result=await this.recoverBatch(part,blocked,{capacityRetry,priceIsolationDepth});
            submitted=submitted||result.submitted;differentActivity=differentActivity||result.differentActivity;
          }
        }else for(const member of group)blocked(member,error);
        continue;
      }
      const eligible=[];
      for(const member of group){
        const result=losses.find(r=>r.productId===member.baseline.productId);
        if(result.error){
          let error=result.error;
          if(error.code==='LIMITED_LOSS_UNPROVEN'&&error.detail?.limitedLoss?.currentAbsence){
            try{
              const review=this.journal.recordRebuildPriceReview(member.plan,error.detail.limitedLoss,this.now());
              error=Object.assign(new Error(review.status==='declined'?'已保留暂不重新创建的选择，可在价格确认页重新核对':'已生成原价格和活动额度的重新创建确认，请在价格确认页核对'),
                {code:'REBUILD_REVIEW_REQUIRED',detail:error.detail});
            }catch(proposalError){this.journal.event(null,'rebuild-review-unavailable',{shopId:this.policy.shopId,productId:member.baseline.productId,code:proposalError.code,message:proposalError.message},this.now());}
          }
          blocked(member,error);continue;
        }
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
          this.checkPriceRules(plan,member.loss);
          requireThat(restorationGroupKey(plan)===restorationGroupKey(member.plan),'BATCH_CHANGED','刷新后的折扣组发生变化，等待重新分组');
          requireThat(this.now()-member.loss.observedAt<=120000,'LOSS_UNPROVEN','批量预查期间失效证明已过期');
          plans.push(plan);proofs.push(member.loss);
        }catch(error){blocked(member,error);}
      }
      if(!plans.length)continue;
      const lossEvidence=lossEvidenceFor(proofs);
      let task=this.journal.enqueue(this.policy.shopId,plans,lossEvidence,this.now());
      if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=this.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence,reason:null},this.now());
      const execution=task.phase==='queued'?await this.execute(task):null;
      task=this.journal.get(task.id);submitted=submitted||task.submitAttempts>0;
      const reportTaskBlocked=(member,error)=>{
        const plan=task.plans.find(p=>p.productId===member.baseline.productId),target=this.journal.priceTarget(this.policy.shopId,member.baseline.productId);
        // execute() may have approved an exact replacement from this direct
        // unsubmitted draft. Its old-price rejection cannot reinstate the
        // cooldown that approval just cleared, including after a restart.
        // The failed task and old approval stay immutable; the replacement
        // still needs fresh loss, SKU, price, draft and submission proofs.
        if(task.phase==='blocked'&&task.submitAttempts===0&&task.riskAttempts===0&&task.submittedAt==null&&task.riskAttemptedAt==null&&
          task.draftProof==null&&task.riskProof==null&&task.receipt==null&&target?.status==='approved'&&target.approvalKind==='automatic-price-increase'&&
          target.id!==plan?.priceApprovalId&&target.historicalFingerprint===plan?.historicalFingerprint&&target.historicalFingerprint===fingerprint(member.baseline)&&
          execution?.priceFailure?.recordedReviews.some(r=>r.id===target.id&&r.productId===plan.productId&&r.shopId===task.shopId)){
          this.journal.clearProductCheck(this.policy.shopId,plan.productId);
          this.journal.event(task.id,'product-target-recheck-pending',{shopId:task.shopId,productId:plan.productId,failedTaskId:task.id,previousApprovalId:plan.priceApprovalId||null,newReviewId:target.id},this.now());
        }else blocked(member,error);
      };
      const capacity=execution?.error?.detail?.formCapacity;
      if(execution?.error?.code==='FORM_BATCH_CAPACITY'&&capacityRetry===0&&task.phase==='blocked'&&task.submitAttempts===0&&
        capacity?.scopeConfirmed&&Number.isInteger(capacity.pageSize)&&capacity.pageSize>0&&capacity.pageSize<plans.length&&
        this.now()-capacity.observedAt>=0&&this.now()-capacity.observedAt<120000){
        this.journal.event(task.id,'batch-capacity-regrouped',{shopId:this.policy.shopId,products:plans.length,observedCapacity:capacity.pageSize,submitAttempts:0},this.now());
        // Only the live, scoped form capacity permits this bounded regroup.
        // Every child obtains new loss/SKU/price proofs; no failed membership or
        // unknown submission is retried through this path.
        const selected=eligible.filter(m=>plans.some(p=>p.productId===m.baseline.productId));
        for(const part of recoveryBatches(selected,{maxProducts:capacity.pageSize,key:m=>restorationGroupKey(m.plan)})){
          if(this.stopRequested)break;
          const result=await this.recoverBatch(part,blocked,{capacityRetry:1,priceIsolationDepth});submitted=submitted||result.submitted;differentActivity=differentActivity||result.differentActivity;
        }
        continue;
      }
      if(!this.stopRequested&&execution?.priceFailure&&priceIsolationDepth<50){
        let isolation=null;
        try{isolation=isolateDraftPriceFailure(task,execution.priceFailure,this.now());}
        catch(error){this.journal.event(task.id,'batch-price-isolation-refused',{shopId:this.policy.shopId,code:error.code||'ERROR',message:error.message},this.now());}
        if(isolation){
          const selected=eligible.filter(m=>isolation.cleanProductIds.includes(m.baseline.productId));
          requireThat(selected.length===isolation.cleanProductIds.length&&selected.length<plans.length,
            'PRICE_ISOLATION_EVIDENCE','重新核对的商品集合不完整或未缩小');
          this.journal.event(task.id,'batch-draft-price-isolated',{shopId:this.policy.shopId,...isolation,submitAttempts:0,riskAttempts:0},this.now());
          for(const member of eligible.filter(m=>isolation.rejectedProductIds.includes(m.baseline.productId)))
            reportTaskBlocked(member,Object.assign(new Error(task.reason||'商品价格需要确认'),{code:'PRICE_REVIEW_REQUIRED'}));
          // Keep every clean member together, within the normal 50/500 budgets.
          // A new task must obtain new absence, SKU, price and draft evidence.
          const result=await this.recoverBatch(selected,blocked,{capacityRetry,priceIsolationDepth:priceIsolationDepth+1});
          submitted=submitted||result.submitted;differentActivity=differentActivity||result.differentActivity;
          continue;
        }
      }
      for(const member of eligible.filter(m=>plans.some(p=>p.productId===m.baseline.productId))){
        if(task.phase==='verified')this.journal.clearProductCheck(this.policy.shopId,member.baseline.productId);
        else if(task.phase==='blocked')reportTaskBlocked(member,Object.assign(new Error(task.reason||'本批未提交'),{code:'RESTORE_BLOCKED'}));
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
      if(knownBlockerCoolingDown(prior,baseline,this.now()))continue;
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
        const detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:String(error.message).slice(0,1000),productState:error.detail?.productState,precheckMembership:error.detail?.precheckMembership,restoreCapacity:error.detail?.restoreCapacity,limitedLoss:error.detail?.limitedLoss};
        this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,watchKey:hint.watchKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+blockerDelay(detail.code)});
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
      const prior=checks.get(baseline.productId),detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:String(error.message).slice(0,1000),productState:error.detail?.productState,precheckMembership:error.detail?.precheckMembership,restoreCapacity:error.detail?.restoreCapacity,limitedLoss:error.detail?.limitedLoss};
      this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,watchKey:hint.watchKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+blockerDelay(detail.code)});
      if(prior?.code!==detail.code||prior?.watchKey!==hint.watchKey)this.journal.event(null,'product-blocked',detail,this.now());
    };
    for(const hint of hints){
      if(this.stopRequested)break;
      const baseline=latest.get(hint.productId);if(!baseline||pending.has(hint.productId)||this.policy.excludedProductIds?.includes(hint.productId))continue;
      const prior=checks.get(hint.productId);
      if(knownBlockerCoolingDown(prior,baseline,this.now()))continue;
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
        this.checkPriceRules(plan,loss);
        const key=restorationGroupKey(plan);if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push({baseline,hint,loss,plan});
      }catch(error){blocked(baseline,hint,error);}
    }
    for(const members of groups.values()){
      if(this.stopRequested)break;
      try{
        requireThat(members.every(m=>this.now()-m.plan.observedAt<=120000&&this.now()-m.loss.observedAt<=120000),'PROOF_EXPIRED','优先恢复的逐商品证据已过期');
        const plans=members.map(m=>m.plan),lossEvidence=lossEvidenceFor(members.map(m=>m.loss));
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
    if(this.immediateEnabled){
      const direct=await this.recoverRequested();
      if(direct.submitted||direct.refreshRequired){this.priorityListing=await this.platform.listActive();return{refreshRequired:true,listing:this.priorityListing};}
    }
    const hints=this.priorityWatch.hints(this.priorityListing);
    let changed=await this.recoverPriority(hints);
    changed=await this.recoverPriceIncreases()||changed;
    if(changed||currentListingKey(listing)!==currentListingKey(this.priorityListing))return{refreshRequired:true,listing:this.priorityListing};
    this.platform.refreshCurrentEvidence?.(this.priorityListing);
    return null;
  }
  async priorityPlanningBoundary(){
    if(this.immediateEnabled){
      await this.settlePriorityPoll();const direct=await this.recoverRequested();
      if(direct.submitted||direct.refreshRequired){this.priorityResume=true;return true;}
    }
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
    const startedAt=this.now();this.patrolStartedAt=startedAt;
    try{
      if(!this.recovered){this.journal.recoverInterrupted(this.policy.shopId,this.now());this.recovered=true;}
      for(const task of this.journal.list(this.policy.shopId).filter(t=>['unknown','verifying'].includes(t.phase))){
        if(this.stopRequested)break;
        try{await this.reconcile(task);}catch(error){this.journal.event(task.id,'verification-pending',{code:error.code||'ERROR',message:error.message},this.now());}
      }
      if(this.stopRequested)return;
      this.nextAt=null;
      if(this.immediateEnabled)await this.recoverRequested();
      if(this.stopRequested)return;
      const historyReadLimit=this.policy.captureExistingOnly?0:!this.journal.histories(this.policy.shopId).length?20:this.now()-this.lastHistoryRead>=15*60000?2:0;
      const discovery=await this.platform.discover({historyReadLimit,...(this.platform.listActive?{onReadBatchStart:()=>this.beginPriorityPoll(),onReadBoundary:context=>this.checkPriority(context)}:{})});if(historyReadLimit)this.lastHistoryRead=this.now();
      for(const baseline of discovery.baselines||[])this.journal.remember(baseline,this.now());
      if(discovery.priorityRefreshRequired){this.priorityResume=true;return{priorityRefreshRequired:true};}
      requireThat(discovery.activeComplete===true,'ACTIVE_UNKNOWN','全店有效活动尚未完整核对，暂停本轮新建');
      const latest=this.latestHistories();
      const groups=new Map(),candidates=[],checks=new Map(this.journal.productChecks(this.policy.shopId).map(c=>[c.productId,c]));
      const blocked=(baseline,loss,error)=>{
        if(error.code==='STOPPED')throw error;
        const detail={shopId:this.policy.shopId,productId:baseline.productId,code:error.code||'ERROR',message:error.message,productState:error.detail?.productState,precheckMembership:error.detail?.precheckMembership,restoreCapacity:error.detail?.restoreCapacity,limitedLoss:error.detail?.limitedLoss,timedLoss:error.detail?.timedLoss};
        this.journal.putProductCheck(this.policy.shopId,baseline.productId,{...detail,lossKey:loss?.lossKey,contextKey:fingerprint(baseline),at:this.now(),retryAt:this.now()+blockerDelay(detail.code)});
        this.journal.event(null,'product-blocked',detail,this.now());
      };
      for(const baseline of latest.values()){
        if(this.stopRequested)break;
        if(this.policy.excludedProductIds?.includes(baseline.productId))continue;
        if(this.journal.list(this.policy.shopId).some(t=>!['verified','blocked'].includes(t.phase)&&t.plans.some(p=>p.productId===baseline.productId)))continue;
        try{
          const cooling=checks.get(baseline.productId);
          if(['LIMITED_LOSS_UNPROVEN','REBUILD_REVIEW_REQUIRED'].includes(cooling?.code)&&cooling.contextKey===fingerprint(baseline)&&cooling.retryAt>this.now()&&this.platform.limitedReference){
            const reference=this.platform.limitedReference(baseline),inventory=this.platform.inventory;
            const currentMember=inventory?.listing?.campaigns.some(c=>['进行中','未开始'].includes(c.status)&&
              inventory.details?.get(c.id)?.products.some(p=>p.productId===baseline.productId&&!p.removalConfirmed));
            if(!currentMember&&cooling.limitedLoss?.referenceCampaignId===reference.campaignId)continue;
          }
          const loss=await this.platform.loss(baseline);if(!loss?.complete)continue;
          if(loss.active){this.journal.clearProductCheck(this.policy.shopId,baseline.productId);if(!loss.ambiguous)this.journal.supersedePriceReviews(this.policy.shopId,baseline.productId,'当前商品已有有效活动',this.now());continue;}
          const prior=checks.get(baseline.productId),same=prior?.lossKey===loss.lossKey&&prior?.contextKey===fingerprint(baseline);
          if(knownBlockerCoolingDown(prior,baseline,this.now()))continue;
          if(same&&prior.retryAt>this.now())continue;
          candidates.push({baseline,loss,retry:same,priorAt:prior?.at||0});
        }catch(error){
          const sourceProduct=error.detail?.productId||error.detail?.limitedLoss?.currentAbsence?.productId;
          const sourceCampaign=error.detail?.campaignId||error.detail?.limitedLoss?.referenceCampaignId;
          if(['LOSS_EVIDENCE_EXPIRED','LIMITED_LOSS_UNPROVEN'].includes(error.code)&&this.platform.precheckBatch&&this.platform.lossBatch&&
            sourceProduct===baseline.productId&&sourceCampaign){
            // This placeholder only groups and schedules a new read. The
            // native recoverBatch path must obtain fresh complete lossBatch
            // proofs before enqueueing any task; it never submits this hint.
            const loss={complete:false,lossKey:fingerprint({kind:'fresh-read-needed',productId:baseline.productId,campaignId:sourceCampaign})};
            const prior=checks.get(baseline.productId),same=prior?.lossKey===loss.lossKey&&prior?.contextKey===fingerprint(baseline);
            if(knownBlockerCoolingDown(prior,baseline,this.now()))continue;
            if(!same||prior.retryAt<=this.now())candidates.push({baseline,loss,retry:same,priorAt:prior?.at||0});
          }else blocked(baseline,null,error);
        }
      }
      if(this.platform.precheckBatch&&this.platform.lossBatch){
        // Cooldown limits repeat work per product. Once due, the whole backlog
        // can drain through bounded batches; priority boundaries between them
        // keep newly lost activities ahead of old failures.
        const eligible=candidates.sort((a,b)=>Number(a.retry)-Number(b.retry)||a.priorAt-b.priorAt);
        for(const batch of recoveryBatches(eligible)){
          if(this.stopRequested)break;
          if(await this.priorityPlanningBoundary())return{priorityRefreshRequired:true};
          await this.recoverBatch(batch,(member,error)=>blocked(member.baseline,member.loss,error));
        }
      }else{
      for(const {baseline,loss} of candidates.sort((a,b)=>Number(a.retry)-Number(b.retry)||a.priorAt-b.priorAt)){
        if(this.stopRequested)break;
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
            const plan=this.restorePlan(baseline,current);this.checkPriceRules(plan,loss);
            plans.push(plan);losses.push(loss);
          }catch(error){this.journal.event(null,'product-blocked',{productId:member.plan.productId,code:error.code||'ERROR',message:error.message},this.now());}
        }
        if(!plans.length)continue;
        requireThat(plans.every(p=>this.now()-p.observedAt<=120000),'PROOF_EXPIRED','本批预查已过期');
        const lossEvidence=lossEvidenceFor(losses);
        let task=this.journal.enqueue(this.policy.shopId,plans,lossEvidence,this.now());
        if(task.phase==='blocked'&&task.submitAttempts===0&&task.retryAfter<=this.now())task=this.journal.transition(task.id,'blocked','queued',{plans,lossEvidence,reason:null},this.now());
        if(task.phase==='queued')await this.execute(task);
      }
      }
      await this.recoverPriceIncreases();
      if(leaseError)throw leaseError;
      requireThat(!this.stopRequested,'STOPPED','本轮巡检已暂停，尚未完成');
      this.recordRun({startedAt,finishedAt:this.now(),ok:true});
    }catch(error){
      this.recordRun({startedAt,finishedAt:this.now(),ok:false,code:error.code||'ERROR',message:String(error.message).slice(0,1000)});
      if(['LOGIN_REQUIRED','READ_CLEANUP_BLOCKED'].includes(error.code))this.stop();
    }
    finally{
      // A stop or failed detail read must also drain the read-only monitor;
      // otherwise the next shop, maintenance handoff or write could overlap it.
      await this.settlePriorityPoll();
      if(this.platform.readHealth?.().quarantined){this.cleanupHeartbeat=heartbeat;this.running=false;this.nextAt=null;}
      else{clearInterval(heartbeat);this.journal.release(this.policy.shopId,this.owner);this.busy=false;
        if(this.requestedResume&&!recoveryRequests(this.journal,this.policy.shopId).paused){this.requestedResume=false;this.stopRequested=false;this.platform.stopping=false;}
        this.wakeImmediate();}
    }
    return this.status();
  }
  start() {
    requireThat(this.policy.liveEnabled&&this.policy.cutoverConfirmed,'CUTOVER_REQUIRED','首次切换尚未确认');
    if(this.running)return;this.running=true;this.stopRequested=false;if(this.immediateEnabled)pauseRecoveryRequests(this.journal,this.policy.shopId,false);
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
  stop({pauseRequests=false}={}) {this.running=false;this.stopRequested=true;this.requestedResume=false;this.nextAt=null;clearTimeout(this.timer);clearTimeout(this.immediateTimer);this.immediateTimer=null;
    if(pauseRequests&&this.immediateEnabled)pauseRecoveryRequests(this.journal,this.policy.shopId,true);this.platform.cancelReads?.();}
}
