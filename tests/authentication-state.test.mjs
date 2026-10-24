import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticationView} from '../src/authentication.mjs';

test('an undated login failure requires authentication until a fresh identity has been verified',()=>{
 const input={shopId:'900001',lastRun:{ok:false,code:'LOGIN_REQUIRED'}};
 assert.equal(authenticationView(input).required,true,'Without any positive identity evidence the login failure must remain visible');
 const recovered={...input,record:{state:'authenticated',lastVerifiedAt:1000},connection:{shopId:'900001'}};
 assert.equal(authenticationView(recovered).required,false,'A newly verified account must clear the older undated error');
 assert.equal(authenticationView({...recovered,lastRun:{ok:false,code:'LOGIN_REQUIRED',finishedAt:2000}}).required,true);
});
