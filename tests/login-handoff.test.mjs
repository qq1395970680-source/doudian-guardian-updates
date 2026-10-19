import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';

async function setup({loginMode=true,probeError=false}={}) {
 const runtime=await mkdtemp(join(tmpdir(),'guardian-login-')),journal=new Journal(':memory:');
 const trace=[],identity={shopId:'900001',name:'测试店铺'};
 const service={running:false,busy:false,status:()=>({tasks:[],verified:0,unknown:0,blocked:0}),stop(){},start(){throw Error('Must not write during login');}};
 const page={url:()=> 'https://fxg.jinritemai.com/ffa/mshop/home',goto:async url=>{trace.push(['navigate',url]);}};
 const browser={loginMode,context:{pages:()=>[page]},async page(){return page;},async close(){trace.push(['close']);this.loginMode=false;}};
 const platform={base:'https://fxg.jinritemai.com',progress:{},identity:async()=>{trace.push(['identity']);return identity;},probe:async()=>{
  trace.push(['probe']);if(probeError)throw Object.assign(Error('Session was not preserved'),{code:'LOGIN_REQUIRED'});return identity;
 }};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal,browser,platform,service}});
 const token=(await(await fetch(app.url)).text()).match(/script nonce="([a-f0-9]+)"/)[1];
 const finish=async()=>{await fetch(app.url+'/api/finish-login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,10));return app.snapshot();};
 return {finish,trace,dispose:async()=>{await app.close();await rm(runtime,{recursive:true,force:true});}};
}

test('login landing on the shop home is verified on a fresh activity page',async()=>{
 const f=await setup();try{const s=await f.finish();assert.equal(s.lastAction.ok,true);assert.equal(s.connection.shopId,'900001');
  assert.deepEqual(f.trace.map(t=>t[0]),['navigate','identity','close','probe']);assert.equal(f.trace[0][1],'https://fxg.jinritemai.com/ffa/marketing/tools/limitsales');
 }finally{await f.dispose();}
});
test('service restart can verify its saved dedicated login without another login window',async()=>{
 const f=await setup({loginMode:false});try{const s=await f.finish();assert.equal(s.lastAction.ok,true);assert.equal(s.connection.shopId,'900001');assert.deepEqual(f.trace,[['probe']]);}finally{await f.dispose();}
});
test('failed headless verification does not leave a stale connected identity',async()=>{
 const f=await setup({probeError:true});try{const s=await f.finish();assert.equal(s.lastAction.ok,false);assert.equal(s.lastAction.code,'LOGIN_REQUIRED');assert.equal(s.connection,null);
  assert.deepEqual(f.trace.map(t=>t[0]),['navigate','identity','close','probe']);
 }finally{await f.dispose();}
});
