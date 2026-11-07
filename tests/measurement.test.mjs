import test from 'node:test';
import assert from 'node:assert/strict';
import {warmFormMeasurement} from '../src/collector.mjs';
const snapshot=count=>({counts:[count],grids:0,total:1,cells:[],dialogs:[],busy:false,title:'合成活动',type:'限时抢购',mode:'在线选择',priceModes:[{raw:'一口价',value:'一口价'}],priceMode:'fixed',byDiscount:false,rules:{noLimit:true},dates:['2026/11/08 00:00:00','2026/11/09 00:00:00'],renew:false,pagination:{present:false}});
test('read-only measurement accepts historical activities beyond the workbook upload cap without claiming coverage',async()=>{
 let reads=0,scrolls=0;const page={async evaluate(fn){if(fn.name==='scrollForm'){scrolls++;return false;}reads++;return snapshot(250);}};
 const result=await warmFormMeasurement(page,250,{pauseMs:20});assert.ok(reads>=2);assert.equal(scrolls,2);assert.equal(result.warmupOnly,true);assert.equal(result.completeVerification,false);assert.deepEqual(result.pages,[1]);assert.deepEqual(result.measurements,[]);
});
test('measurement cannot remove finite time, step, page or activity limits',async()=>{
 const page={async evaluate(){throw Error('must reject before touching page');}};
 for(const [count,options]of [[20001,{}],[1,{budgetMs:60001}],[1,{maxSteps:601}],[1,{maxPages:101}],[1,{pauseMs:0}]])await assert.rejects(warmFormMeasurement(page,count,options),e=>e.code==='WARMUP_LIMIT');
});
test('a count or rule change during measurement remains a scope failure',async()=>{
 let reads=0;const page={async evaluate(fn){if(fn.name==='scrollForm')return false;return snapshot(++reads===1?250:249);}};
 await assert.rejects(warmFormMeasurement(page,250,{pauseMs:20}),e=>e.code==='WARMUP_SCOPE');
});
