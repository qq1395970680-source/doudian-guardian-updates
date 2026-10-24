import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {createApp} from '../src/server.mjs';

for(const consent of [false,true])test(`upgrade resume preserves shop consent and only resumes an authorized original guard: consent=${consent}`,async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-upgrade-resume-')),journal=new Journal(':memory:'),accounts=new AccountRegistry(journal);
 accounts.register({shopId:'900001'},'shop-900001');if(consent)accounts.authorizeOriginal('900001');
 journal.putSettings('900001',{autoStart:false,executionEnabled:true});let starts=0;
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),start(){starts++;this.running=true;},stop(){this.running=false;}};
 const platform={progress:{stage:'testing'},probe:async()=>({shopId:'900001'}),discover:async()=>({baselines:[],activeComplete:true,errors:[]})};
 const app=await createApp({runtime,port:0,resumeOnUpgrade:true,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,5));
  assert.equal(starts,consent?1:0);assert.equal(app.snapshot().originalRestoreAuthorized,consent);
  assert.equal(app.snapshot().automaticPriceIncreaseEnabled,false);assert.equal(journal.settings('900001').autoStart,consent);
 }finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});

test('a stop acknowledgement during upgrade login cannot be undone when the delayed probe finishes',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-upgrade-stop-')),journal=new Journal(':memory:'),accounts=new AccountRegistry(journal);
 accounts.register({shopId:'900001'},'shop-900001');accounts.authorizeOriginal('900001');journal.putSettings('900001',{autoStart:true,executionEnabled:true});
 let resolveProbe,starts=0;const pending=new Promise(r=>resolveProbe=r);
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),start(){starts++;this.running=true;},stop(){this.running=false;}};
 const platform={stopping:false,progress:{stage:'尚未连接'},probe:async()=>pending};
 const app=await createApp({runtime,port:0,resumeOnUpgrade:true,dependencies:{journal,service,platform,browser:{close:async()=>{}}}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/script nonce="([a-f0-9]+)"/)[1];
  const response=await fetch(app.url+'/api/stop',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Guardian-Token':token},body:'{}'});
  assert.equal(response.ok,true);assert.equal((await response.json()).running,false);resolveProbe({shopId:'900001'});
  while(app.snapshot().action)await new Promise(r=>setTimeout(r,5));
  assert.equal(starts,0);assert.equal(service.running,false);assert.equal(journal.settings('900001').autoStart,false);
 }finally{resolveProbe({shopId:'900001'});await app.close();await rm(runtime,{recursive:true,force:true});}
});
