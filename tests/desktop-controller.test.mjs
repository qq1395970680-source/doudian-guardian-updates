import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {probeService,ensureService,postControl,shutdownService,isAllowedNavigation,upgradeService} from '../desktop/service-controller.mjs';

const status={build:'isolated-headless-journal',shopId:'900001',instance:'test-instance',sourceBuild:'test-build',running:true,busy:false,unknown:0};
async function fixture(t,handler){
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return 'http://127.0.0.1:'+server.address().port;
}
test('desktop reuses the existing same-shop backend without launching a writer',async t=>{
 const url=await fixture(t,(_q,r)=>r.end(JSON.stringify(status)));let launches=0;
 const result=await ensureService({url,shopId:status.shopId,launch:async()=>{launches++;}});
 assert.equal(result.reused,true);assert.equal(launches,0);
});
test('only an explicitly refused connection permits a backend launch',async t=>{
 const url=await fixture(t,(_q,r)=>r.end(JSON.stringify(status)));let probes=0,launches=0;
 const result=await ensureService({url,shopId:status.shopId,probe:async()=>++probes===1?{state:'absent'}:{state:'ready',status},launch:async()=>{launches++;},sleep:async()=>{}});
 assert.equal(result.reused,false);assert.equal(launches,1);
});
for(const kind of ['503','wrong-shop','wrong-app','bad-json','reset','timeout'])test('ambiguous backend '+kind+' never starts a second process',async t=>{
 const url=await fixture(t,(q,r)=>{
  if(kind==='timeout')return;
  if(kind==='reset'){q.socket.destroy();return;}
  if(kind==='503'){r.writeHead(503);r.end('maintenance');return;}
  r.end(kind==='bad-json'?'not-json':JSON.stringify({...status,...(kind==='wrong-shop'?{shopId:'other'}:kind==='wrong-app'?{build:'other'}:{})}));
 });let launches=0;
 await assert.rejects(ensureService({url,shopId:status.shopId,timeoutMs:60,launch:async()=>{launches++;}}));assert.equal(launches,0);
});
test('control refreshes its nonce and never follows an unexpected redirect',async t=>{
 const calls=[];const token='a'.repeat(64);
 const url=await fixture(t,(q,r)=>{calls.push({path:q.url,method:q.method,origin:q.headers.origin,token:q.headers['x-guardian-token']});
  if(q.url==='/')return r.end('<script nonce="'+token+'"></script>');
  if(q.url==='/api/status')return r.end(JSON.stringify(status));
  r.writeHead(202);r.end('{"ok":true}');
 });await postControl({url,shopId:status.shopId,path:'stop'});
 const action=calls.find(c=>c.method==='POST');assert.equal(action.origin,url);assert.equal(action.token,token);
 const redirected=await fixture(t,(_q,r)=>{r.writeHead(302,{Location:url});r.end();});
 await assert.rejects(postControl({url:redirected,shopId:status.shopId,path:'stop'}));
});
test('quit waits for in-flight work before shutdown and never kills a process',async()=>{
 const calls=[];let reads=0;
 await shutdownService({url:'http://127.0.0.1:19417',shopId:status.shopId,probe:async()=>({state:++reads>3?'absent':'ready',status:{...status,running:false,busy:reads<3}}),control:async({path})=>calls.push(path),sleep:async()=>{},timeoutMs:1000});
 assert.deepEqual(calls,['stop','shutdown']);assert.ok(reads>=3);
});
test('a stalled quit does not issue shutdown while work is in flight',async()=>{
 const calls=[];let time=0;
 await assert.rejects(shutdownService({url:'http://127.0.0.1:19417',shopId:status.shopId,probe:async()=>({state:'ready',status:{...status,busy:true}}),control:async({path})=>calls.push(path),sleep:async()=>{time+=100;},now:()=>time,timeoutMs:200}));
 assert.deepEqual(calls,['stop']);
});
test('desktop navigation is limited to its local workbench, never arbitrary files or network',()=>{
 const origin='http://127.0.0.1:19417';
 assert.equal(isAllowedNavigation(origin+'/',origin),true);
 for(const target of ['file:///C:/secret','https://evil.example','http://127.0.0.1:19418/','http://127.0.0.1:19417@evil.example/','javascript:alert(1)'])assert.equal(isAllowedNavigation(target,origin),false);
});
test('a newer bundle waits for idle and resolved submissions; it never interrupts a writer',async()=>{
 for(const pending of [{busy:true},{unknown:1},{action:'login'}]){
  let stopped=0;const result=await upgradeService({shopId:status.shopId,expectedBuild:'new',probe:async()=>({state:'ready',status:{...status,...pending}}),control:async()=>stopped++});
  assert.equal(result.state,'pending');assert.equal(stopped,0);
 }
});
test('idle upgrade preserves resume intent and waits for confirmed old service exit',async()=>{
 const calls=[];let reads=0;
 const result=await upgradeService({shopId:status.shopId,expectedBuild:'new',probe:async()=>({state:++reads===1?'ready':'absent',status}),
  control:async c=>calls.push([c.path,c.args]),sleep:async()=>{},start:async()=>calls.push('launch')});
 assert.equal(result.state,'upgraded');assert.deepEqual(calls,[['shutdown',{resumeOnLaunch:true}],'launch']);
});

test('an older desktop never rolls a newer service backwards even when the build differs',async()=>{
 let controls=0;const r=await upgradeService({expectedBuild:'older-build',expectedVersion:'2.0.0-beta.2',probe:async()=>({state:'ready',status:{...status,version:'2.0.0-beta.3'}}),control:async()=>controls++});
 assert.equal(r.state,'newer-service');assert.equal(controls,0);
});

test('an independent desktop accepts first-run and any valid selected shop without hardcoded account',async t=>{
 for(const shopId of [null,'900002']){const url=await fixture(t,(_q,r)=>r.end(JSON.stringify({...status,shopId})));assert.equal((await probeService({url})).status.shopId,shopId);}
});
