import test from 'node:test';
import assert from 'node:assert/strict';
import {LoginStability,waitForAuthenticatedAccount} from '../src/login-state.mjs';

test('brief SSO login observations cannot expire a verified account and reset on an authenticated page',()=>{
 const s=new LoginStability(),page={};
 assert.equal(s.observe(page,{login:true},1000),false);
 assert.equal(s.observe(page,{login:true},2000),false);
 assert.equal(s.observe(page,{login:false},3000),false);
 assert.equal(s.observe(page,{login:true},4000),false);
 assert.equal(s.observe(page,{login:true},6250),true);
 assert.equal(s.observe({}, {login:true},10000),false,'A different account page has independent evidence');
});
test('a redirect that restores its own visible account is accepted without a false LOGIN_REQUIRED',{timeout:6000},async()=>{
 let reads=0;const expected={names:['测试店铺'],ids:['900001'],login:false};
 const page={evaluate:async()=>++reads<5?{names:[],ids:[],login:true}:expected};
 assert.deepEqual(await waitForAuthenticatedAccount(page,{read:()=>{},requireIds:true}),expected);
 assert.ok(reads>=5);
});
test('a persistent login form stays unauthenticated and requires a human login',{timeout:6000},async()=>{
 const page={evaluate:async()=>({names:[],ids:[],login:true})};
 await assert.rejects(waitForAuthenticatedAccount(page,{read:()=>{}}),{code:'LOGIN_REQUIRED'});
});
test('a cancelled read cannot become authenticated on a late identity response',async()=>{
 const page={evaluate:async()=>({names:['测试店铺'],ids:['900001'],login:false})};let checks=0;
 await assert.rejects(waitForAuthenticatedAccount(page,{read:()=>{},check(){if(++checks>1)throw Object.assign(Error('cancelled'),{code:'STOPPED'});}}),{code:'STOPPED'});
});
