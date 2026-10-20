import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../src/server.mjs';
import {DedicatedBrowser} from '../../src/browser.mjs';
import {DoudianPlatform} from '../../src/platform.mjs';
import {Journal} from '../../src/journal.mjs';
import {fixtureServer,fixtureProducts} from './platform-fixture.mjs';

test('native headless onboarding isolates two shops and a fresh second runtime without importing consent or history',{timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'guardian-onboarding-flow-'));
 const stores=[
  {id:'900071',name:'本地甲店',discount:60,cookie:'local-fixture-a'},
  {id:'900082',name:'本地乙店',discount:55,cookie:'local-fixture-b'}
 ];
 const fixture=await fixtureServer();
 for(const store of stores){
  store.state=structuredClone(fixture.state);store.state.identity={shopId:store.id,shopName:store.name};
  const campaign=structuredClone(store.state.campaigns[0]);
  Object.assign(campaign,{id:'4000000000000000099',name:'当前活动',status:'进行中',startAt:Date.now()-60000,endAt:Date.now()+3600000});
  campaign.products=[{...structuredClone(fixtureProducts[0]),name:store.name+'当前商品'}];
  for(const sku of campaign.products[0].skus)sku.discount=store.discount;
  store.state.campaigns.push(campaign);
 }
 fixture.state.accounts=new Map(stores.map(s=>[s.cookie,s.state]));
 let loginTarget=stores[0],app=null,journal=null,browser=null;
 const profiles=[];
 class FixtureLoginBrowser extends DedicatedBrowser {
  // Authentication is represented by a synthetic local-only cookie. This
  // test neither automates nor claims to verify a real account login flow.
  async openLogin(){
   const key='signin-'+randomUUID();profiles.push(key);
   await this.open(loginTarget.id,{profileKey:key});
   await this.context.addCookies([{name:'guardian-fixture-account',value:loginTarget.cookie,url:fixture.base,httpOnly:true,sameSite:'Lax',expires:Math.floor(Date.now()/1000)+3600}]);
   this.loginMode=true;return key;
  }
 }
 const launch=async(name,viewport)=>{
  const runtime=join(directory,name);journal=new Journal(join(runtime+'.sqlite'));
  browser=new FixtureLoginBrowser(join(runtime,'browser'),{test:true,viewport});
  app=await createApp({runtime,port:0,dependencies:{journal,browser,platformFactory:policy=>new DoudianPlatform({browser,policy,journal,base:fixture.base})}});
  const token=(await(await fetch(app.url)).text()).match(/script nonce="([a-f0-9]+)"/)[1];
  return async(path,args={})=>{
   const response=await fetch(app.url+'/api/'+path,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args)});
   return{status:response.status,body:await response.json()};
  };
 };
 const idle=async()=>{
  const until=Date.now()+90000;while(app.snapshot().action||app.snapshot().busy){if(Date.now()>until)throw Error('Local onboarding did not settle');await new Promise(r=>setTimeout(r,50));}
 };
 const connect=async post=>{
  assert.equal((await post('login')).status,202);await idle();assert.equal(app.snapshot().lastAction.ok,true);
  assert.equal((await post('finish-login')).status,202);await idle();assert.equal(app.snapshot().lastAction.ok,true,app.snapshot().lastAction.message);
 };
 const catalog=async()=>await(await fetch(app.url+'/api/products')).json();
 const checkCurrent=async store=>{
  const c=await catalog();assert.equal(c.shopId,store.id);assert.equal(c.complete,true);assert.equal(c.counts.observedCurrentProducts,1);
  assert.equal(c.products.length,1,'ended history must not enter a fresh account');
  assert.equal(c.products[0].name,store.name+'当前商品');assert.equal(c.products[0].current[0].skus.length,10);
  assert.ok(c.products[0].current[0].skus.every(s=>s.discount===store.discount));
  assert.equal(journal.histories(store.id).length,1);assert.equal(browser.loginMode,false);
 };
 try{
  let post=await launch('first-device',{width:1440,height:960});assert.equal(app.snapshot().shopId,null);assert.deepEqual(app.snapshot().accounts,[]);
  await connect(post);await checkCurrent(stores[0]);assert.equal(app.snapshot().originalRestoreAuthorized,false);
  assert.equal((await post('start')).status,400);assert.equal((await post('start',{originalDiscountConsent:true})).status,202);
  assert.equal((await post('stop')).status,202);await idle();assert.equal(app.snapshot().originalRestoreAuthorized,true);
  loginTarget=stores[1];await connect(post);await checkCurrent(stores[1]);
  assert.equal(app.snapshot().originalRestoreAuthorized,false);assert.equal((await post('start')).status,400);
  assert.deepEqual(app.snapshot().excluded,[]);assert.equal(journal.histories(stores[0].id).length,1);
  assert.equal((await post('accounts/select',{shopId:stores[0].id})).status,202);await idle();assert.equal(app.snapshot().lastAction.ok,true,app.snapshot().lastAction.message);
  await checkCurrent(stores[0]);assert.equal(app.snapshot().originalRestoreAuthorized,true,'only this store retains its own prior consent');
  const registry=journal.settings('application');assert.equal(new Set(registry.accounts.map(a=>a.profileKey)).size,2);
  stores[0].state.identity.shopId=stores[1].id;
  assert.equal((await post('audit')).status,202);await idle();assert.equal(app.snapshot().lastAction.ok,false);
  assert.equal(app.snapshot().lastAction.code,'SHOP_MISMATCH','a changed rendered account must fail before any writes');
  stores[0].state.identity.shopId=stores[0].id;
  await app.close();app=null;
  loginTarget=stores[0];post=await launch('fresh-second-device',{width:960,height:600});
  assert.equal(app.snapshot().shopId,null);assert.deepEqual(app.snapshot().accounts,[]);await connect(post);await checkCurrent(stores[0]);
  assert.equal(app.snapshot().originalRestoreAuthorized,false);assert.equal((await post('start')).status,400);
  assert.equal(journal.histories(stores[1].id).length,0);assert.equal(new Set(profiles).size,3);
  for(const store of stores){assert.equal(store.state.submits,0);assert.equal(store.state.uploads,0);assert.equal(store.state.creates,0);}
  const report={at:new Date().toISOString(),localFixtureOnly:true,physicalSecondComputer:false,realSecondAccount:false,authentication:'synthetic local-only cookie supplied as test setup',
   nativeHeadlessBrowser:true,storeIds:stores.map(s=>s.id),separatePersistentProfiles:3,separateRuntimeDatabases:2,viewports:[{width:1440,height:960},{width:960,height:600}],
   currentOnlyCapture:true,automaticIdentity:true,sameProductIdsDifferentPricesIsolated:true,originalConsentIsolated:true,profileIdentityMismatchRejected:true,
   freshDeviceRequiresOwnConsent:true,submits:0,uploads:0};
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/onboarding-native-flow.json'),JSON.stringify(report,null,2)+'\n');
 }finally{
  if(app)await app.close();else {await browser?.close();try{journal?.close();}catch{}}
  await fixture.close();await rm(directory,{recursive:true,force:true});
 }
});
