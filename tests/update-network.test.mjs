import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateFetcher} from '../desktop/update-network.mjs';

test('update check uses the direct connection before a rate-limited system proxy',async()=>{
 let systemCalls=0;
 const fetcher=createUpdateFetcher({directFetch:async()=>new Response('[]'),systemFetch:async()=>{systemCalls++;return new Response('rate limited',{status:403});}});
 assert.equal((await fetcher('https://api.github.com/repos/example/releases')).status,200);assert.equal(systemCalls,0);
});
test('connection failure falls back once to the system network without changing request options',async()=>{
 const options={redirect:'manual',headers:{'User-Agent':'Guardian-test'}};let called=0;
 const fetcher=createUpdateFetcher({directFetch:async()=>{throw new TypeError('fetch failed');},systemFetch:async(url,init)=>{called++;assert.equal(url,'https://github.com/example');assert.equal(init,options);return new Response('ok');}});
 assert.equal(await(await fetcher('https://github.com/example',options)).text(),'ok');assert.equal(called,1);
});
test('HTTP rate limits and server errors are returned without alternate-network retries',async()=>{
 for(const status of [403,429,503]){
  let systemCalls=0;const fetcher=createUpdateFetcher({directFetch:async()=>new Response('error',{status}),systemFetch:async()=>{systemCalls++;return new Response('ok');}});
  assert.equal((await fetcher('https://api.github.com/example')).status,status);assert.equal(systemCalls,0);
 }
});
test('a cancelled or expired request never starts a secondary request',async()=>{
 const control=new AbortController();control.abort();let systemCalls=0;
 const fetcher=createUpdateFetcher({directFetch:async()=>{throw control.signal.reason;},systemFetch:async()=>{systemCalls++;return new Response('ok');}});
 await assert.rejects(()=>fetcher('https://github.com/example',{signal:control.signal}));assert.equal(systemCalls,0);
});
