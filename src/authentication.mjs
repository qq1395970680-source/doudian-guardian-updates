export function authenticationView({shopId,record=null,connection=null,lastRun=null,lastAction=null,readHealth=null,loginOpen=false,persistence=null}){
 const verifiedAt=record?.lastVerifiedAt||0;
 const failures=[lastRun,lastAction,readHealth?.last].filter(v=>v?.code==='LOGIN_REQUIRED').map(v=>({at:v.finishedAt||v.at||0,message:v.message}));
 const lastFailure=failures.sort((a,b)=>b.at-a.at)[0];
 const required=record?.state==='required'||!!lastFailure&&(!verifiedAt||lastFailure.at>verifiedAt);
 return{state:loginOpen?'signing-in':required?'required':connection?'authenticated':'unverified',required,
  shopId,lastVerifiedAt:verifiedAt||null,expiredAt:required?(record?.expiredAt||lastFailure?.at||null):null,
  message:required?'专用浏览器登录已失效，守护已暂停；请重新登录本店':loginOpen?'在专用窗口完成登录后，点击登录完成':null,
  persistentSession:persistence};
}
export function markAuthenticationRequired(journal,shopId,error,now=Date.now()){
 if(!shopId)return;
 const key='authentication:'+shopId,prior=journal.settings(key);
 if(prior?.state==='required')return;
 const record={schema:1,shopId,state:'required',expiredAt:now,lastVerifiedAt:prior?.lastVerifiedAt||null,code:'LOGIN_REQUIRED',
  message:'专用浏览器登录已失效，等待重新登录',at:now};
 journal.putSettings(key,record);journal.event(null,'account-login-required',{shopId,code:'LOGIN_REQUIRED',message:record.message},now);
}
export function markAuthenticated(journal,identity,now=Date.now(),{force=false}={}){
 const key='authentication:'+identity.shopId,prior=journal.settings(key);
 if(!force&&prior?.state==='authenticated'&&now-prior.lastVerifiedAt<60000)return;
 const record={schema:1,shopId:identity.shopId,state:'authenticated',lastVerifiedAt:now,at:now};journal.putSettings(key,record);
 if(prior?.state==='required')journal.event(null,'account-login-restored',{shopId:identity.shopId,message:'原店铺登录已重新核对，任务与价格记录保留'},now);
}
