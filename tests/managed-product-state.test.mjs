import test from 'node:test';
import assert from 'node:assert/strict';
import {proveManagedProductSlice} from '../src/product-state.mjs';
const scope={shopId:'900001',productId:'300001',now:1793093400000};
const observed=()=>({path:'/ffa/g/list',selectedTabs:['全部'],headers:['','商品信息','价格','总库存','总销量','质量分','创建时间','操作'],
 rows:[{key:'300001',cells:['','商品 ID：300001','100','9','0','未诊断','2026/05/02\n14:42:11\n已下架\n查看原因','编辑 上架 更多']}],totals:[1],empty:false,busy:false});

test('a uniquely scoped managed-product row proves its actual off-shelf state',()=>{
 const proof=proveManagedProductSlice(observed(),scope);
 assert.equal(proof.source,'live-platform-product-management');assert.equal(proof.kind,'off-shelf');assert.equal(proof.status,'已下架');
 assert.equal(proof.shopId,scope.shopId);assert.equal(proof.productId,scope.productId);assert.equal(proof.observedAt,scope.now);assert.equal(proof.complete,true);
});
test('empty all-products results do not prove off-shelf or deleted state',()=>{
 assert.equal(proveManagedProductSlice({...observed(),rows:[],totals:[0],empty:true},scope),null);
});
test('a selling status is not replaced by an off-shelf menu label in another cell',()=>{
 const s=observed();s.rows[0].cells[6]='2026/05/02\n14:42:11\n售卖中';s.rows[0].cells[7]='编辑 下架 已下架';
 const proof=proveManagedProductSlice(s,scope);assert.equal(proof.kind,'managed-product-state');assert.equal(proof.status,'售卖中');
});
for(const [name,mutate] of [
 ['wrong route',s=>s.path='/ffa/g/recycle'],
 ['wrong category',s=>s.selectedTabs=['售卖中']],
 ['conflicting categories',s=>s.selectedTabs=['全部','已下架']],
 ['missing status column',s=>s.headers[6]='更新时间'],
 ['missing totals',s=>s.totals=[]],
 ['busy query',s=>s.busy=true],
 ['wrong row key',s=>s.rows[0].key='300002'],
 ['different displayed ID',s=>s.rows[0].cells[1]='商品 ID：300002'],
 ['duplicate product rows',s=>{s.rows.push(structuredClone(s.rows[0]));s.totals=[2];}],
 ['duplicate displayed IDs',s=>s.rows[0].cells[1]+=' ID：300001'],
 ['conflicting statuses',s=>s.rows[0].cells[6]+='\n售卖中'],
 ['missing status',s=>s.rows[0].cells[6]='2026/05/02 14:42:11'],
 ['incomplete cells',s=>s.rows[0].cells.pop()],
 ['zero total with an actual row',s=>s.totals=[0]],
 ['conflicting totals',s=>s.totals=[1,0]],
 ['unverified empty marker',s=>{s.rows=[];s.totals=[0];}],
])test(`${name} cannot prove an off-shelf product`,()=>{const s=observed();mutate(s);assert.throws(()=>proveManagedProductSlice(s,scope));});
