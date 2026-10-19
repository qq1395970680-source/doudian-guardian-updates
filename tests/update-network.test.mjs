import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateFetcher,createSystemUpdateFetcher,isAllowedUpdateUrl} from '../desktop/update-network.mjs';

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

test('system-network policy limits downloads to HTTPS GitHub assets without credentials or nonstandard ports',()=>{
 const root='https://github.com/example/releases/download/v1/setup.exe';
 for(const host of ['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'])assert.equal(isAllowedUpdateUrl('https://'+host+'/asset',root),true);
 for(const url of ['http://github.com/asset','https://github.com:8443/asset','https://user:password@github.com/asset','https://github.com.evil.example/asset','https://api.github.com/asset','file:///tmp/setup.exe','not a url'])assert.equal(isAllowedUpdateUrl(url,root),false,url);
 assert.equal(isAllowedUpdateUrl('https://api.github.com/repos/example/releases'),true);
 assert.equal(isAllowedUpdateUrl(root,'https://api.github.com/repos/example/releases'),false);
});

test('system fallback initializes lazily and enforces every hop, cleans terminal requests, and omits credentials',async()=>{
 let created=0,lastOptions;const handlers={};
 const network={webRequest:Object.fromEntries(['onBeforeRequest','onCompleted','onErrorOccurred'].map(name=>[name,fn=>handlers[name]=fn])),fetch:async(url,options)=>{lastOptions=options;return new Response('ok');}};
 const fetcher=createSystemUpdateFetcher({getSession:()=>{created++;return network;}});
 assert.equal(created,0);
 const signal=new AbortController().signal;
 await fetcher('https://github.com/example',{redirect:'manual',signal,headers:{Accept:'application/octet-stream'}});
 assert.equal(created,1);assert.equal(lastOptions.redirect,'follow');assert.equal(lastOptions.signal,signal);assert.equal(lastOptions.credentials,'omit');assert.equal(lastOptions.cache,'no-store');assert.equal(lastOptions.bypassCustomProtocolHandlers,true);
 const before=(id,url)=>{let result;handlers.onBeforeRequest({id,url},r=>result=r);return result.cancel;};
 for(let i=0;i<5;i++)assert.equal(before(1,'https://github.com/asset'),false);
 assert.equal(before(1,'https://github.com/asset'),true);handlers.onErrorOccurred({id:1});
 assert.equal(before(1,'https://github.com/asset'),false);handlers.onCompleted({id:1});
 assert.equal(before(2,'https://github.com/asset'),false);
 assert.equal(before(2,'https://untrusted.example/asset'),true);handlers.onErrorOccurred({id:2});
 await fetcher('https://api.github.com/repos/example/releases',{redirect:'error'});assert.equal(lastOptions.redirect,'error');assert.equal(created,1);
 await assert.rejects(()=>fetcher('http://github.com/asset'),/来源/);
});
