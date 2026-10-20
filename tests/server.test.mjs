import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';

test('local workbench rejects foreign origin and cannot enable writes before login and shop-specific consent',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-server-')),journal=new Journal(':memory:');let starts=0;
 const service={running:false,busy:false,status:()=>({tasks:[],verified:0,unknown:0,blocked:0}),start(){starts++;this.running=true;},stop(){this.running=false;}};
 const browser={loginMode:false,context:{pages:()=>[{url:()=> 'https://fxg.jinritemai.com/ffa/marketing/tools/limitsales'}]},async open(_s,{login}){this.loginMode=login;},async close(){this.loginMode=false;},async page(){return{goto:async()=>{}};}};
 const platform={base:'https://fxg.jinritemai.com',progress:{stage:'testing'},identity:async()=>({shopId:'900001'}),probe:async()=>({shopId:'900001'})};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal,browser,platform,service}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  const post=(path,args={},origin=app.url)=>fetch(app.url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Guardian-Token':token,Origin:origin},body:JSON.stringify(args)});
  assert.equal((await post('login',{},'https://attacker.example')).status,400);assert.equal(browser.loginMode,false);
  assert.equal((await post('start',{legacyStopped:true})).status,400);assert.equal(starts,0);
  assert.equal(app.snapshot().automaticPriceIncreaseEnabled,false);
  assert.equal((await post('price-increase-policy',{shopId:'900001',enabled:true,acceptHigherPricesAndRisk:true})).status,400);
  assert.equal((await post('login')).status,202);while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  assert.equal((await post('finish-login')).status,202);while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));
  assert.equal((await post('start')).status,400);assert.equal(starts,0);
  assert.equal((await post('price-increase-policy',{shopId:'900001',enabled:true})).status,400);
  assert.equal((await post('price-increase-policy',{shopId:'900002',enabled:true,acceptHigherPricesAndRisk:true})).status,400);
  assert.equal((await post('price-increase-policy',{shopId:'900001',enabled:true,acceptHigherPricesAndRisk:true})).status,200);
  assert.equal(app.snapshot().automaticPriceIncreaseEnabled,true);assert.equal(starts,0);
  assert.equal((await post('price-increase-policy',{shopId:'900001',enabled:false})).status,200);
  assert.equal(app.snapshot().automaticPriceIncreaseEnabled,false);
  assert.equal((await post('start',{originalDiscountConsent:true})).status,202);assert.equal(starts,1);
  assert.equal((await post('stop')).status,202);assert.equal(service.running,false);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
