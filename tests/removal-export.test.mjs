import test from 'node:test';
import assert from 'node:assert/strict';
import {zip} from '../src/workbook.mjs';
import {readRemovalWorkbook,checkRemovalPrices} from '../src/removal-export.mjs';

const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const reason='该商品各SKU售卖价，最高价需在最低价的3.5倍以内，请修改后再提交。平台规范合理设置SKU价格';
export const removalWorkbook=(rows,headers=['商品ID','商品名','渠道id','渠道类型','失败原因'])=>zip({
 'xl/worksheets/sheet1.xml':'<?xml version="1.0"?><worksheet><sheetData>'+[headers,...rows].map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,j)=>'<c r="'+String.fromCharCode(65+j)+(i+1)+'" t="str"><v>'+escape(v)+'</v></c>').join('')+'</row>').join('')+'</sheetData></worksheet>'
});
test('platform removal workbook preserves long text identifiers and exact reasons without evaluating cells',()=>{
 const records=readRemovalWorkbook(removalWorkbook([['3848196081326358908','商品','--','--',reason]]));
 assert.deepEqual(records,[{productId:'3848196081326358908',name:'商品',reason}]);
});
test('observed main-product channel is accepted while other channels remain unproven',()=>{
 const record=['3817223180347638046','商品','0','主品',reason];
 assert.equal(readRemovalWorkbook(removalWorkbook([record]))[0].productId,record[0]);
 for(const [channel,type] of [['1','主品'],['0','其他'],['--','主品'],['10001','渠道']]){
  assert.throws(()=>readRemovalWorkbook(removalWorkbook([[record[0],record[1],channel,type,reason]])));
 }
});
for(const mode of ['wrong-header','duplicate','scientific-id','empty-reason','formula','bad-crc','oversize','xml-entity'])
test('removal workbook fails closed: '+mode,()=>{
 let bytes=removalWorkbook([['300001','商品','--','--',reason]]);
 if(mode==='wrong-header')bytes=removalWorkbook([['300001','商品','--','--',reason]],['其他ID','商品名','渠道id','渠道类型','失败原因']);
 if(mode==='duplicate')bytes=removalWorkbook([['300001','商品','--','--',reason],['300001','商品','--','--',reason]]);
 if(mode==='scientific-id')bytes=removalWorkbook([['3.848196081326358E+18','商品','--','--',reason]]);
 if(mode==='empty-reason')bytes=removalWorkbook([['300001','商品','--','--','']]);
 if(mode==='formula')bytes=zip({'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1"><f>HYPERLINK("bad")</f><v>商品ID</v></c></row></sheetData></worksheet>'});
 if(mode==='bad-crc')bytes[60]^=1;
 if(mode==='oversize')bytes=Buffer.alloc(4*1024*1024+1);
 if(mode==='xml-entity')bytes=zip({'xl/worksheets/sheet1.xml':'<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file://secret">]><worksheet>&x;</worksheet>'});
 assert.throws(()=>readRemovalWorkbook(bytes));
});
test('ratio constraints block the rejected price without granting any lower-price permission',()=>{
 const plan={productId:'300001',skus:[{id:'500001',name:'低价',baseFen:4700,discount:50,saleFen:2350},{id:'500002',name:'高价',baseFen:50300,discount:50,saleFen:25150}]};
 assert.throws(()=>checkRemovalPrices(plan,{reason}),error=>{
  assert.equal(error.code,'SKU_RATIO_REVIEW_REQUIRED');assert.equal(error.detail.increaseOnlyPossible,false);
  assert.equal(error.detail.maxToMinRatio,3.5);return true;
 });
 assert.deepEqual(plan.skus.map(s=>s.discount),[50,50]);
 assert.doesNotThrow(()=>checkRemovalPrices({...plan,skus:plan.skus.map(s=>({...s,saleFen:5000}))},{reason}));
});
