import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {createApp} from '../../src/server.mjs';
import {dualDecisionFixture} from './dual-activity-fixture.mjs';
export async function recoveryWorkspaceApp(options={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-recovery-workspace-')),journal=new Journal(':memory:'),f=dualDecisionFixture(journal,options);
 f.platform.probe=async()=>({shopId:f.policy.shopId,name:'双方案工作台测试'});
 const service=new GuardianService({journal,platform:f.platform,policy:f.policy,immediate:false});
 const app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,platform:f.platform,browser:{close:async()=>{}}}});
 const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
 const post=(path,args)=>fetch(app.url+'/api/'+path,{method:'POST',headers,body:JSON.stringify(args)}),get=async path=>{const response=await fetch(app.url+'/api/'+path);if(!response.ok)throw Error(await response.text());return response.json();};
 await post('finish-login',{});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
 return{...f,journal,service,app,post,get,async close(){await app.close();await rm(runtime,{recursive:true,force:true});}};
}
