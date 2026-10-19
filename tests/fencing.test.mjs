import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
test('an expired writer cannot submit after another owner takes over',()=>{
 const j=new Journal(':memory:');try{j.lease('900001','old',1000,1000);j.lease('900001','new',2001,1000);
 assert.throws(()=>j.assertLease('900001','old',2002),{code:'LEASE_LOST'});j.assertLease('900001','new',2002);
 }finally{j.close();}
});
