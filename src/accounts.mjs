import {id,requireThat} from './policy.mjs';

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
 authorizeOriginal(shopId){const a=this.data.accounts.find(a=>a.shopId===id(shopId));requireThat(a,'ACCOUNT_UNKNOWN','店铺尚未登录');
  Object.assign(a,{originalRiskAllowed:true,allowMissingHistoricalSkus:true,allowFurtherPriceReduction:false,authorizationSource:'用户在本程序按店铺确认原折扣恢复',authorizationAt:Date.now()});this.save();return a;}
}
