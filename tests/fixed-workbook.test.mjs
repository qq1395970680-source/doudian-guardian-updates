import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorkbook,assertFixedPriceTemplate,headers,fixedPriceHeaders,zip} from '../src/workbook.mjs';
const plan=()=>({shopId:'900001',productId:'3000000000000000099',type:'限时抢购',priceMode:'fixed',rules:{noLimit:true},skus:[{id:'5000000000000000099',name:'任意金额',baseFen:10000,discount:null,saleFen:4784}]});
function storedPart(bytes,name){let at=0;while(bytes.readUInt32LE(at)===0x04034b50){const size=bytes.readUInt32LE(at+18),n=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),path=bytes.subarray(at+30,at+30+n).toString(),start=at+30+n+extra;if(path===name)return bytes.subarray(start,start+size).toString();at=start+size;}throw Error('missing part');}
test('fixed workbook writes exact amount, retains identifier text and deterministic bytes',()=>{
 const p=plan(),bytes=makeWorkbook([p]),sheet=storedPart(bytes,'xl/worksheets/sheet1.xml');
 assert.match(sheet,/一口价（必填）/);assert.match(sheet,/<c r="A2" s="1" t="inlineStr"><is><t xml:space="preserve">3000000000000000099/);assert.match(sheet,/<c r="C2" t="n"><v>47\.84<\/v>/);assert.doesNotMatch(sheet,/<v>0\.47/);assert.deepEqual(bytes,makeWorkbook([p]));assert.equal(assertFixedPriceTemplate(bytes).decimalPlaces,2);
});
test('fixed workbook preserves exact cents for both supported activity cards',()=>{for(const type of ['限时抢购','限量抢购']){const p=plan();p.type=type;assert.equal(assertFixedPriceTemplate(makeWorkbook([p])).maximumPercent,95);}});
test('fixed and discount cannot share one official workbook',()=>{const a=plan(),b=plan();b.productId='3000000000000000098';delete b.priceMode;b.skus=[{...b.skus[0],id:'5000000000000000098',discount:60,saleFen:6000}];assert.throws(()=>makeWorkbook([a,b]),e=>e.code==='WORKBOOK_GROUP');});
test('fixed workbook rejects approximate discounts, fractional cents and above-template amounts',()=>{for(const change of [{discount:48},{saleFen:4784.1},{saleFen:9501},{saleFen:0}]){const p=plan();Object.assign(p.skus[0],change);assert.throws(()=>makeWorkbook([p]));}});
test('official fixed template verification rejects discount and changed rules',()=>{
 const p=plan(),legacy={...p,priceMode:'discount',skus:p.skus.map(s=>({...s,discount:60,saleFen:6000}))};assert.throws(()=>assertFixedPriceTemplate(makeWorkbook([legacy])),e=>e.code==='FIXED_TEMPLATE_FORMAT');
 const xml=v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;');for(const cells of [headers,fixedPriceHeaders.map((h,i)=>i===2?h.replace('95','99'):h)]){const sheet='<worksheet><sheetData><row r="1">'+cells.map((h,i)=>'<c r="'+String.fromCharCode(65+i)+'1" t="inlineStr"><is><t>'+xml(h)+'</t></is></c>').join('')+'</row></sheetData></worksheet>';assert.throws(()=>assertFixedPriceTemplate(zip({'xl/worksheets/sheet1.xml':sheet})),e=>e.code==='FIXED_TEMPLATE_FORMAT');}
});
test('official fixed template supports shared-string headers and rejects corrupt ZIP',()=>{
 const escape=v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;'),strings='<sst>'+fixedPriceHeaders.map(h=>'<si><t>'+escape(h)+'</t></si>').join('')+'</sst>',sheet='<worksheet><sheetData><row r="1">'+fixedPriceHeaders.map((_h,i)=>'<c r="'+String.fromCharCode(65+i)+'1" t="s"><v>'+i+'</v></c>').join('')+'</row></sheetData></worksheet>';
 const bytes=zip({'xl/sharedStrings.xml':strings,'xl/worksheets/sheet1.xml':sheet});assert.equal(assertFixedPriceTemplate(bytes).source,'current-native-fixed-price-template');const bad=Buffer.from(bytes);bad[65]^=1;assert.throws(()=>assertFixedPriceTemplate(bad));
});
