import test from 'node:test';
import assert from 'node:assert/strict';
import {DedicatedBrowser} from '../src/browser.mjs';

function isolated(cookies){const b=new DedicatedBrowser('checkpoint-memory-only');b.context={cookies};b.profilePath='never-used-profile-secret';return b;}
test('a 3-second cookie timeout reports its actual stage without invoking a vault or exposing private data',{timeout:6000},async()=>{
 let calls=0;const b=isolated(()=>{calls++;return new Promise(()=>{});});await Promise.all([b.checkpointSession(),b.checkpointSession()]);
 assert.equal(calls,1);assert.equal(b.sessionSaving,null);assert.equal(b.sessionPersistence.state,'unavailable');assert.equal(b.sessionPersistence.available,false);assert.equal(b.sessionPersistence.code,'SESSION_COOKIE_READ_TIMEOUT');assert.equal(b.sessionPersistence.stage,'read');assert.ok(b.sessionPersistence.elapsedMs>=2900);assert.match(b.sessionPersistence.message,/读取超时.*原资料保留.*自动重试/);assert.doesNotMatch(JSON.stringify(b.sessionPersistence),/权限|存储|profile-secret/);
});
test('a cookie read error stores only a safe diagnostic code and never its private message',async()=>{
 const b=isolated(async()=>{throw Object.assign(Error('cookie-secret profile-secret token-secret'),{code:'bad-secret-code'});});await b.checkpointSession();assert.equal(b.sessionPersistence.code,'SESSION_COOKIE_READ_FAILED');assert.equal(b.sessionPersistence.stage,'read');assert.doesNotMatch(JSON.stringify(b.sessionPersistence),/cookie-secret|profile-secret|token-secret|bad-secret-code|权限/);
});
test('a late checkpoint error cannot replace a new context persistence state',async()=>{
 let fail;const b=isolated(()=>new Promise((_,reject)=>{fail=reject;})),pending=b.checkpointSession(),next={state:'ready',available:true,at:123};b.context={cookies:async()=>[]};b.sessionPersistence=next;fail(Error('old context closed'));await pending;assert.equal(b.sessionPersistence,next);assert.equal(b.sessionSaving,null);
});
test('a late successful cookie read after context replacement never proceeds to the old vault',async()=>{
 let finish;const b=isolated(()=>new Promise(resolve=>{finish=resolve;})),pending=b.checkpointSession(),next={state:'saved',available:true,at:456};b.context={cookies:async()=>[]};b.sessionPersistence=next;finish([]);await pending;assert.equal(b.sessionPersistence,next);assert.equal(b.sessionSaving,null);
});
