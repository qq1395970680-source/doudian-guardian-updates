import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';

test('expired selected account reuses its persistent profile and stale connection cannot claim authenticated',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-auth-persistence-')),j=new Journal(':memory:');let captured=null,service;
 const identity={shopId:'900001',name:'原店铺',observedAt:Date.now()};
 const browser={loginMode:false,close:async()=>{browser.loginMode=false;},openLogin:async args=>{captured=args;browser.loginMode=true;return args?.profileKey||'signin-new';},page:async()=>({goto:async()=>{}})};
 const app=await createApp({port:0,runtime,config:{shopId:identity.shopId,name:identity.name,profileKey:'signin-stable-profile'},
  dependencies:{journal:j,browser,platformFactory:()=>({base:'https://fxg.jinritemai.com',progress:{},identify:async()=>identity,probe:async()=>identity,discover:async()=>({activeComplete:true,baselines:[],errors:[]})}),
   serviceFactory:()=>service={running:false,busy:false,lastRun:{code:'LOGIN_REQUIRED',ok:false,finishedAt:Date.now()},status(){return{lastRun:this.lastRun,unknown:0,tasks:[]};},stop(){this.running=false;},start(){this.running=true;}}}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  const post=(route,args={})=>fetch(app.url+'/api/'+route,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:JSON.stringify(args)});
  const idle=async()=>{while(app.snapshot().action)await new Promise(r=>setTimeout(r,5));assert.notEqual(app.snapshot().lastAction?.ok,false,app.snapshot().lastAction?.message);};
  assert.equal(app.snapshot().authentication?.required,true);
  await post('login');await idle();assert.equal(captured.profileKey,'signin-stable-profile');assert.equal(captured.shopId,identity.shopId);
  await post('finish-login');await idle();assert.equal(app.snapshot().authentication.required,false);
  service.lastRun={code:'LOGIN_REQUIRED',ok:false,finishedAt:Date.now()+1};
  assert.equal(app.snapshot().connection,null);assert.equal(app.snapshot().authentication.required,true);
  assert.equal(j.settings('application').accounts[0].profileKey,'signin-stable-profile');
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});
