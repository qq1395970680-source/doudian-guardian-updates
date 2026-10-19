import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';
import {catalogObservation} from '../src/catalog.mjs';

test('fresh install auto-identifies two accounts, discovers current discounts without writing, and isolates consent and views',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-onboarding-')),journal=new Journal(':memory:');let identity={shopId:'900001',name:'第一家店'},writes=0,reads=0;
 const browser={loginMode:false,close:async()=>{browser.loginMode=false;},openLogin:async()=>{browser.loginMode=true;return'signin-'+identity.shopId;},page:async()=>({goto:async()=>{}})};
 const platformFactory=policy=>({base:'https://fxg.jinritemai.com',progress:{},identify:async()=>identity,probe:async()=>identity,async discover(options){
  reads++;assert.equal(options.historyReadLimit,0);const now=Date.now(),productId=policy.shopId==='900001'?'300001':'300002',c={id:'400001',name:'店铺活动',status:'进行中',startAt:now-1000,endAt:now+1e6};
  const p={productId,name:identity.name+'商品',skus:[{id:'500001',name:'标准规格',baseFen:20000,discount:50,saleFen:10000}]};
  this.inventory={listing:{complete:true,observedAt:now,campaigns:[c]},activeComplete:true,details:new Map([[c.id,{complete:true,observedAt:now,products:[p]}]])};
  journal.putSettings('catalog-view:'+policy.shopId,catalogObservation(policy.shopId,this.inventory));
  return{activeComplete:true,errors:[],baselines:[{source:'verified-platform-history',complete:true,shopId:policy.shopId,...p,campaignId:c.id,historyAt:c.startAt,type:'限时抢购',rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30}}]};
 }});
 const serviceFactory=({policy})=>({running:false,busy:false,status:()=>({tasks:[],unknown:0}),start(){writes++;assert.equal(policy.originalRiskAllowed,true);this.running=true;},stop(){this.running=false;}});
 const app=await createApp({port:0,runtime,dependencies:{journal,browser,platformFactory,serviceFactory}});
 try{
  const html=await(await fetch(app.url)).text();assert.doesNotMatch(html,/旧版|旧扩展|接管|交接|275897201/);assert.equal(app.snapshot().shopId,null);
  const token=html.match(/script nonce="([a-f0-9]+)"/)[1];const post=(p,args={})=>fetch(app.url+'/api/'+p,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args)});
  const idle=async()=>{while(app.snapshot().action)await new Promise(r=>setTimeout(r,5));assert.notEqual(app.snapshot().lastAction?.ok,false,app.snapshot().lastAction?.message);};
  await post('login');await idle();await post('finish-login');await idle();assert.equal(reads,1);assert.equal(writes,0);assert.equal(app.snapshot().shopId,'900001');
  let catalog=await(await fetch(app.url+'/api/products')).json();assert.equal(catalog.counts.observedCurrentProducts,1);assert.equal(catalog.products[0].current[0].skus[0].saleFen,10000);
  const count=journal.events().length;await fetch(app.url+'/api/products');assert.equal(journal.events().length,count);assert.equal(writes,0);
  assert.equal((await post('start')).status,400);assert.equal((await post('start',{originalDiscountConsent:true})).status,202);await post('stop');
  identity={shopId:'900002',name:'第二家店'};await post('login');await idle();await post('finish-login');await idle();assert.equal(app.snapshot().originalRestoreAuthorized,false);assert.equal((await post('start')).status,400);
  catalog=await(await fetch(app.url+'/api/products')).json();assert.deepEqual(catalog.products.map(p=>p.productId),['300002']);assert.equal(reads,2);assert.equal(writes,1);
  const restartedDisplay=journal.settings('catalog-view:900001');assert.equal(restartedDisplay.shopId,'900001');assert.equal(journal.histories('900001').length,1);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
