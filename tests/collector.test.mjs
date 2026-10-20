import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleCells,bindFormProducts,collectForm} from '../src/collector.mjs';
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
test('virtual heights can settle over more than five mounts, but two complete equal reads remain required',async()=>{
 let mounted=0,reads=0,completed=0;
 const page={evaluate:async fn=>{
  if(fn.name==='scrollForm'){reads=0;return;}
  reads++;
  const changed=reads>1&&mounted<6;
  if(changed)mounted++;
  if(reads>1&&!changed)completed++;
  return{busy:false,grids:1,total:changed?160:150,cells:structuredClone(cells),counts:[1],page:1,mode:'online'};
 }};
 const result=await collectForm(page,{precheck:true});
 assert.equal(mounted,6);assert.equal(completed,2);assert.equal(result.products[0].skus.length,1);
});
test('stable geometry does not permit continuously changing prices',async()=>{
 let pass=0;
 const page={evaluate:async fn=>{
  if(fn.name==='scrollForm'){pass++;return;}
  const rows=structuredClone(cells);rows[1].rows[0].baseFen=10000+(pass%2)*100;
  return{busy:false,grids:1,total:150,cells:rows,counts:[1],page:1,mode:'online'};
 }};
 await assert.rejects(()=>collectForm(page,{precheck:true}),{code:'FORM_UNSTABLE'});
 assert.equal(pass,5);
});
