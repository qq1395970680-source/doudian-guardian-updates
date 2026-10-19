import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
test('fresh install has no shop, no inherited price authorization and no hardcoded account',()=>{
 const j=new Journal(':memory:');try{const a=new AccountRegistry(j);assert.equal(a.selected(),null);
  a.register({shopId:'900001',name:'甲店'},'signin-a');a.authorizeOriginal('900001');
  a.register({shopId:'900002',name:'乙店'},'signin-b');assert.equal(a.selected().shopId,'900002');
  assert.equal(a.selected().originalRiskAllowed,false);assert.deepEqual(a.selected().excludedProductIds,[]);
  a.select('900001');assert.equal(a.selected().originalRiskAllowed,true);assert.equal(a.selected().profileKey,'signin-a');
 }finally{j.close();}
});
test('relogin preserves only the same shop policy and distinct dedicated profile mapping',()=>{
 const j=new Journal(':memory:');try{const a=new AccountRegistry(j);a.register({shopId:'900001',name:'甲'},'signin-a');a.authorizeOriginal('900001');
  a.register({shopId:'900001',name:'甲改名'},'signin-c');assert.equal(a.selected().originalRiskAllowed,true);
  const loaded=new AccountRegistry(j);assert.equal(loaded.selected().profileKey,'signin-c');assert.equal(loaded.selected().allowFurtherPriceReduction,false);
  assert.throws(()=>a.select('900099'));assert.throws(()=>a.register({shopId:'../bad'},'signin-b'));
 }finally{j.close();}
});
