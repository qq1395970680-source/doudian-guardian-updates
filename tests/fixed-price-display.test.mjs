import test from 'node:test';
import assert from 'node:assert/strict';
import {isFixedPrice,priceModeLabel,inputMoneyFen,moneyInputValue,largestReductionPercent} from '../public/price-display.js';

test('fixed price display requires an explicit mode and never infers it from a missing discount',()=>{
 assert.equal(isFixedPrice({priceMode:'fixed'}),true);
 assert.equal(priceModeLabel({priceMode:'fixed'}),'一口价');
 assert.equal(isFixedPrice({discount:null,saleFen:4739}),false);
 assert.equal(priceModeLabel({}),'按折扣');
});
test('yuan input keeps exact cents and rejects implicit rounding, exponents and invalid amounts',()=>{
 for(const [input,fen]of [['0.01',1],['47.39',4739],['47.3',4730],['47',4700],['1000000.00',100000000]])assert.equal(inputMoneyFen(input),fen,input);
 for(const input of ['',null,'0','-0.01','47.391','1e2','1,000','+12','Infinity','NaN','1000000.01'])assert.equal(inputMoneyFen(input),null,String(input));
 assert.equal(moneyInputValue(4739),'47.39');
 assert.equal(moneyInputValue(null),'');
});
test('reduction warning compares the displayed guarded target without inventing an actual selling price',()=>{
 assert.equal(largestReductionPercent([{previousFen:21056,saleFen:11200},{previousFen:5000,saleFen:5000}]),'46.8');
 assert.equal(largestReductionPercent([{previousFen:0,saleFen:1},{previousFen:500,saleFen:600}]),null);
});
