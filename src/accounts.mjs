import {id,requireThat,fingerprint,normalizeName} from './policy.mjs';

// All records are owned by this application. Public installers carry no shop,
// exclusions, login profile, history or price authorization.
export class AccountRegistry {
 constructor(journal){this.journal=journal;this.data=journal.settings('application')||{selected:null,accounts:[]};}
 save(){this.journal.putSettings('application',this.data);}
 selected(){return this.data.accounts.find(a=>a.shopId===this.data.selected)||null;}
 list(){return this.data.accounts.map(a=>({shopId:a.shopId,name:a.name}));}
 select(shopId){id(shopId);requireThat(this.data.accounts.some(a=>a.shopId===shopId),'ACCOUNT_UNKNOWN','请先登录这家店铺');this.data.selected=shopId;this.save();return this.selected();}
 register(identity,profileKey,explicitPolicy=null){
  const shopId=id(identity.shopId);requireThat(/^(shop-\d+|signin-[a-zA-Z0-9-]+)$/.test(profileKey),'PROFILE_SCOPE','专用登录资料无效');
  requireThat(!this.data.accounts.some(a=>a.shopId!==shopId&&a.profileKey===profileKey),'PROFILE_SCOPE','此登录目录已属于另一家店铺，请使用添加店铺创建独立登录');
  let account=this.data.accounts.find(a=>a.shopId===shopId);
  if(!account){account={shopId,name:identity.name||'店铺',profileKey,excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:false,
   allowFurtherPriceReduction:false,captureExistingOnly:true};this.data.accounts.push(account);}
  if(explicitPolicy)Object.assign(account,explicitPolicy,{shopId});
  Object.assign(account,{name:identity.name||account.name,profileKey,allowFurtherPriceReduction:false});
  this.data.selected=shopId;this.save();return account;
 }
 // Registering an independent login does not select it, inherit another
 // shop's authority, or resume any worker. Check the current durable registry
 // inside the transaction so late login results cannot overwrite a change.
 appendIndependent(identity,profileKey,{expectedApplicationKey=null}={}){
  const shopId=id(identity?.shopId),name=normalizeName(identity?.name);
  requireThat(name.length>0&&name.length<=200,'ACCOUNT_IDENTITY','新店铺名称尚未完整核实');
  requireThat(typeof profileKey==='string'&&/^signin-[a-zA-Z0-9-]+$/.test(profileKey),'PROFILE_SCOPE','独立添加店铺必须使用本程序新建的登录资料');
  const saved=this.journal.transaction(()=>{
   const current=this.journal.settings('application')||{selected:null,accounts:[]};
   requireThat(Array.isArray(current.accounts)&&(!expectedApplicationKey||fingerprint(current)===expectedApplicationKey),'ACCOUNT_REGISTRY_CHANGED','店铺列表或原授权已变化，请重新核对后添加');
   requireThat(!current.accounts.some(a=>a.shopId===shopId),'ACCOUNT_ALREADY_EXISTS','这家店铺已经添加，原账号与登录资料保持不变');
   requireThat(!current.accounts.some(a=>a.profileKey===profileKey),'PROFILE_SCOPE','新登录资料已被其他店铺使用');
   const account={shopId,name,profileKey,excludedProductIds:[],allowMissingHistoricalSkus:true,originalRiskAllowed:false,
    allowFurtherPriceReduction:false,captureExistingOnly:true,executionEnabled:false,cutoverConfirmed:false};
   const next={...current,accounts:[...current.accounts,account]};this.journal.putSettings('application',next);return{next,account};
  });
  this.data=saved.next;return saved.account;
 }
 authorizeOriginal(shopId){const a=this.data.accounts.find(a=>a.shopId===id(shopId));requireThat(a,'ACCOUNT_UNKNOWN','店铺尚未登录');
  Object.assign(a,{originalRiskAllowed:true,allowMissingHistoricalSkus:true,allowFurtherPriceReduction:false,authorizationSource:'用户在本程序按店铺确认原折扣恢复',authorizationAt:Date.now()});this.save();return a;}
}
