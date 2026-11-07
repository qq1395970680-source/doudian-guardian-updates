// Bounded, read-only rechecks of the same dedicated account. This controller
// never logs in, copies another profile, extends a cookie or grants execution.
export class AuthenticationRecovery {
 constructor({now=Date.now,backoffs=[5000,30000,120000]}={}){this.now=now;this.backoffs=backoffs;this.pending=null;}
 request(shopId){
  if(!shopId||this.pending?.shopId===shopId)return;
  this.pending={shopId,attempts:0,rechecking:false,nextRetryAt:this.now()+this.backoffs[0],exhausted:false};
 }
 begin(shopId){
  const p=this.pending;if(!p||p.shopId!==shopId||p.rechecking||p.exhausted||p.nextRetryAt>this.now())return false;
  p.rechecking=true;p.nextRetryAt=null;p.attempts++;return true;
 }
 finish(shopId,success){
  const p=this.pending;if(!p||p.shopId!==shopId)return;
  if(success){this.pending=null;return;}
  p.rechecking=false;p.exhausted=p.attempts>=this.backoffs.length;p.nextRetryAt=p.exhausted?null:this.now()+this.backoffs[p.attempts];
 }
 cancel(){this.pending=null;}
 view(shopId){const p=this.pending;return !p||p.shopId!==shopId?{rechecking:false,recheckAttempts:0,nextRetryAt:null,recheckExhausted:false}:{rechecking:p.rechecking,recheckAttempts:p.attempts,nextRetryAt:p.nextRetryAt,recheckExhausted:p.exhausted};}
}
