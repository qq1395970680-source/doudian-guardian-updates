import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecoveryIssues} from '../src/recovery-issues.mjs';
test('missing recovery without a price proposal remains visible; pending proposals and unavailable products do not duplicate it',()=>{
 const row=(productId,extra={})=>({productId,history:{},current:[],scheduled:[],...extra});
 const products=[row('300001',{check:{code:'TIMED_LOSS_UNPROVEN',message:'退出明细待核验',at:1000}}),row('300002'),
  row('300003',{check:{code:'PRODUCT_RECYCLED'}}),row('300004',{excluded:true}),row('300005',{pending:true}),row('300006',{current:[{}]}),row('300007')];
 const issues=buildRecoveryIssues({stale:true,products},[{productId:'300007',status:'pending'}]);
 assert.deepEqual(issues.map(p=>p.productId),['300001','300002']);
 assert.equal(issues[0].message,'退出明细待核验');assert.equal(issues[1].code,'CURRENT_RECHECK_PENDING');
 assert.equal(issues[1].stale,true);assert.match(issues[1].message,/不表示已经恢复/);
});
