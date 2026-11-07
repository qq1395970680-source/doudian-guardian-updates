// A redirect to SSO can briefly render a login URL/form while an existing
// platform session is being restored. It is not positive account evidence.
// Require it to remain visible before declaring the whole account expired.
export class LoginStability {
 constructor({stableMs=2250,minimumSamples=2}={}){this.stableMs=stableMs;this.minimumSamples=minimumSamples;this.observations=new WeakMap();}
 observe(page,value,now=Date.now()){
  if(!value?.login){this.observations.delete(page);return false;}
  let prior=this.observations.get(page);
  if(!prior){prior={at:now,samples:0};this.observations.set(page,prior);}
  prior.samples++;
  return prior.samples>=this.minimumSamples&&now-prior.at>=this.stableMs;
 }
}
export async function waitForAuthenticatedAccount(page,{read,check=()=>{},timeoutMs=25000,requireIds=false,stableMs=2250}={}){
 const stability=new LoginStability({stableMs}),deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  check();let account;
  try{account=await page.evaluate(read);}catch(error){
   // Navigation can replace the execution context during a legitimate SSO
   // redirect. No account is accepted from a failed or stale evaluation.
   if(!/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/i.test(String(error?.message)))throw error;
  }
  check();
  if(account){
   if(stability.observe(page,account))throw Object.assign(Error('专用浏览器需要重新登录，已确认登录页面持续显示'),{code:'LOGIN_REQUIRED'});
   if(!account.login&&account.names?.length===1&&(!requireIds||account.ids?.length))return account;
  }
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw Object.assign(Error(requireIds?'尚未读取到店铺 ID':'店铺名称尚未加载'),{code:'LOAD_TIMEOUT'});
}
