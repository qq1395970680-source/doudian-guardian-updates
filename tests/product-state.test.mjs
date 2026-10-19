import test from 'node:test';
import assert from 'node:assert/strict';
import {proveRecycleSlice} from '../src/product-state.mjs';
const now=Date.parse('2026-10-19T22:30:00Z'),scope={shopId:'900001',productId:'300001',now};
const observed=()=>({path:'/ffa/g/recycle',headers:['','商品信息','价格','总库存','总销量','质量分','创建时间','进入回收站时间','操作'],
 rows:[{key:'300001',cells:['','商品 ID：300001','100','9','0','无','2026/01/01 12:00:00','2026/10/18 14:01:36','恢复 彻底删除']}],totals:[1],empty:false,busy:false});
test('only a uniquely identified recycle row proves product recycling',()=>{
 const p=proveRecycleSlice(observed(),scope);assert.equal(p.kind,'recycled');assert.equal(p.productId,'300001');assert.equal(p.shopId,'900001');assert.equal(p.observedAt,now);assert.equal(p.source,'live-platform-product-recycle');
});
test('an explicit empty result does not prove a product was removed',()=>{
 assert.equal(proveRecycleSlice({...observed(),rows:[],totals:[0],empty:true},scope),null);
});
for(const [name,mutate] of [
 ['wrong route',s=>s.path='/ffa/g/list'],['wrong id',s=>s.rows[0].key='300002'],
 ['row ID differs',s=>s.rows[0].cells[1]='商品 ID：300002'],['duplicate identifier',s=>s.rows[0].cells[1]+=' ID：300001'],
 ['duplicate row',s=>{s.rows.push(structuredClone(s.rows[0]));s.totals=[2];}],
 ['incomplete result',s=>s.totals=[]],['conflicting totals',s=>s.totals=[1,20]],
 ['busy result',s=>s.busy=true],['missing date',s=>s.rows[0].cells[7]='—'],
 ['invalid date',s=>s.rows[0].cells[7]='2026/02/30 14:01:36'],['future date',s=>s.rows[0].cells[7]='2027/10/18 14:01:36'],
 ['different table',s=>s.headers[7]='更新时间'],['incomplete cells',s=>s.rows[0].cells.pop()],
 ['zero count with a row',s=>s.totals=[0]]
])test(`${name} never proves a recycled product`,()=>{const s=observed();mutate(s);assert.throws(()=>proveRecycleSlice(s,scope));});
