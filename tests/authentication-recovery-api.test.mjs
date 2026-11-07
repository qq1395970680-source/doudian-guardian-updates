import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';

async function setup({resume=false,wrongAccount=false}={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-auth-recovery-api-')),journal=new Journal(':memory:');let now=Date.now(),starts=0,probes=0;
 journal.putSettings('900001',{executionEnabled:true,autoStart:resume});
 const identity={shopId:'900001',name:'原店铺'},platform={base:'https://fxg.jinritemai.com',progress:{},readHealth:()=>({active:[],quarantined:false}),probe:async()=>{probes++;return wrongAccount?{...identity,shopId:'900002'}:identity;}};
 const service={running:false,busy:false,lastRun:null,status(){return{tasks:[],unknown:0,lastRun:this.lastRun};},stop(){this.running=false;},start(){starts++;this.running=true;}};
 const browser={loginMode:false,close:async()=>{},checkpointSession:async()=>{}};
 const app=await createApp({port:0,runtime,config:{shopId:'900001',name:identity.name,profileKey:'signin-original',originalRiskAllowed:true},dependencies:{journal,browser,platform,service,authenticationRecoveryOptions:{now:()=>now,backoffs:[5,30,120]}}});
 const idle=async()=>{while(app.snapshot().action)await new Promise(r=>setTimeout(r,5));};await idle();
 const body=JSON.stringify({title:'守护2-000000000000000000',plans:[{shopId:'900001',productId:'300001',name:'原未知商品',skus:[{id:'500001',name:'原规格',baseFen:10000,discount:50,saleFen:5000}]}],createdAt:Date.now(),submittedAt:Date.now(),submitAttempts:1,riskAttempts:1,reason:'原提交只允许回读'});
 journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('a0000000-0000-4000-8000-000000000001','900001','fixture-unknown','unknown',body,Date.now());
 return{app,journal,service,platform,idle,advance:n=>{now+=n;},counts:()=>({starts,probes}),body,dispose:async()=>{await app.close();await rm(runtime,{recursive:true,force:true});}};
}
for(const resume of [false,true])test('same-profile background identity recheck preserves unknown submission and only resumes existing execution consent: '+resume,async()=>{
 const f=await setup({resume});
 try{
  const before=f.counts();f.platform.onAuthenticationFailure(Object.assign(Error('expired'),{code:'LOGIN_REQUIRED'}));assert.equal(f.app.snapshot().authentication.required,true);
  f.advance(5);await f.app.recheckAuthentication();await f.idle();
  assert.equal(f.app.snapshot().authentication.required,false);assert.equal(f.app.snapshot().connection.shopId,'900001');
  assert.equal(f.counts().starts-before.starts,resume?1:0);assert.equal(f.service.running,resume);
  assert.equal(f.journal.db.prepare('SELECT body FROM tasks WHERE dedupe=?').get('fixture-unknown').body,f.body,'Rechecking never clears, retries or edits the unknown financial task');
  assert.equal(f.journal.settings('application').accounts[0].profileKey,'signin-original');
 }finally{await f.dispose();}
});
test('an identity recheck cannot switch accounts, and stopping cancels further background checks',async()=>{
 const f=await setup({wrongAccount:true});
 try{
  f.platform.onAuthenticationFailure(Object.assign(Error('expired'),{code:'LOGIN_REQUIRED'}));f.advance(5);await f.app.recheckAuthentication();await f.idle();
  assert.equal(f.app.snapshot().authentication.required,true);assert.equal(f.app.snapshot().connection,null);assert.equal(f.app.snapshot().shopId,'900001');assert.equal(f.counts().starts,0);
  const html=await(await fetch(f.app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  const response=await fetch(f.app.url+'/api/stop',{method:'POST',headers:{Origin:f.app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});assert.equal(response.status,202);
  const before=f.counts().probes;f.advance(10000);await f.app.recheckAuthentication();await f.idle();assert.equal(f.counts().probes,before);
 }finally{await f.dispose();}
});

for(const outcome of ['login-failure','success'])test('stop during an in-flight recheck ignores its late '+outcome+' and never schedules another probe',async()=>{
 const f=await setup();let settle;
 try{
  f.platform.probe=()=>new Promise((resolve,reject)=>{settle=()=>outcome==='success'?resolve({shopId:'900001',name:'原店铺'}):reject(Object.assign(Error('late expired'),{code:'LOGIN_REQUIRED'}));});
  f.platform.onAuthenticationFailure(Object.assign(Error('expired'),{code:'LOGIN_REQUIRED'}));f.advance(5);await f.app.recheckAuthentication();
  while(!settle)await new Promise(r=>setTimeout(r,5));
  const html=await(await fetch(f.app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  const response=await fetch(f.app.url+'/api/stop',{method:'POST',headers:{Origin:f.app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});assert.equal(response.status,202);
  settle();await f.idle();assert.equal(f.app.snapshot().authentication.nextRetryAt,null);assert.equal(f.app.snapshot().authentication.rechecking,false);
  f.advance(10000);await f.app.recheckAuthentication();await f.idle();assert.equal(f.counts().starts,0);assert.equal(f.service.running,false);
  assert.equal(f.journal.db.prepare('SELECT body FROM tasks WHERE dedupe=?').get('fixture-unknown').body,f.body);
 }finally{settle?.();await f.dispose();}
});
