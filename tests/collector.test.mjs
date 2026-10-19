import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleCells,bindFormProducts} from '../src/collector.mjs';
const cells=[{top:0,height:50,rows:[{kind:'product',productId:'300001'}]},
 {top:50,height:50,rows:[{kind:'sku',name:'甲',baseFen:10000}]},{top:100,height:50,rows:[{kind:'tail'}]}];
test('virtual traversal needs physical coverage from first row through tail',()=>{
 assert.equal(assembleCells(cells,150)[0].skus.length,1);
 assert.throws(()=>assembleCells([cells[0],cells[2]],150),{code:'VIRTUAL_GAP'});
 assert.throws(()=>assembleCells(cells.slice(0,2),150),{code:'VIRTUAL_GAP'});
});
test('virtual duplicate names cannot be accepted as missing history',()=>{
 const copy=structuredClone(cells);copy[1].rows.push(copy[1].rows[0]);assert.throws(()=>assembleCells(copy,150),{code:'DUPLICATE_SKU'});
});
test('draft mapping retains prices actually shown instead of replacing them with planned ones',()=>{
 const p=assembleCells(cells,150);p[0].skus[0].saleFen=5900;p[0].skus[0].discount=59;
 const rows=bindFormProducts(p,[{productId:'300001',skus:[{id:'500001',name:'甲',baseFen:10000,discount:60,saleFen:6000}]}]);
 assert.equal(rows[0].id,'500001');assert.equal(rows[0].saleFen,5900);assert.equal(rows[0].discount,59);
});
