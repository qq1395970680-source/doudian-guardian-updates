import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthenticationRecovery} from '../src/authentication-recovery.mjs';
test('same-account authentication rechecks are bounded, back off and cannot be reset by repeated failure callbacks',()=>{
 let now=1000;const r=new AuthenticationRecovery({now:()=>now,backoffs:[5,30,120]});r.request('900001');
 assert.equal(r.begin('900002'),false);assert.equal(r.begin('900001'),false);
 now=1005;assert.equal(r.begin('900001'),true);assert.equal(r.begin('900001'),false);r.finish('900001',false);r.request('900001');
 assert.equal(r.view('900001').nextRetryAt,1035);now=1035;assert.equal(r.begin('900001'),true);r.finish('900001',false);
 now=1155;assert.equal(r.begin('900001'),true);r.finish('900001',false);r.request('900001');
 assert.equal(r.view('900001').recheckExhausted,true);assert.equal(r.view('900001').recheckAttempts,3);assert.equal(r.begin('900001'),false);
 r.cancel();assert.equal(r.view('900001').nextRetryAt,null);
});
test('a late result for another selected account cannot clear or resume its pending authentication',()=>{
 let now=0;const r=new AuthenticationRecovery({now:()=>now,backoffs:[1]});r.request('900001');now=1;r.begin('900001');
 r.cancel();r.request('900002');r.finish('900001',true);assert.equal(r.view('900002').nextRetryAt,2);
 now=2;r.begin('900002');r.finish('900002',true);assert.equal(r.view('900002').rechecking,false);assert.equal(r.view('900002').nextRetryAt,null);
});
