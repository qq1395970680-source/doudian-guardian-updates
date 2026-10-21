import test from 'node:test';
import assert from 'node:assert/strict';
import * as pricing from '../src/price-review.mjs';

test('explicit 15-day numeric floors and strict bounds are not mistaken for the day count',()=>{
 for(const [text,key,value] of [
  ['活动价不得低于近15天最低价（68元）','minFen',6800],
  ['活动价格不能低于最近15天内最低生效标价(￥68.01元)','minFen',6801],
  ['折后价必须高于近15天最低价（68元）','minFen',6801],
  ['折后价必须低于近15天最低价（68元）','maxFen',6799],
  ['单品活动价¥69.50，需≥¥70.00','minFen',7000],
 ])assert.equal(pricing.parsePriceConstraint(text)?.[key],value,text);
});

test('one complete numeric interval retains both bounds and inclusive or strict endpoints',()=>{
 for(const [text,minFen,maxFen] of [
  ['68元≤活动价≤72元',6800,7200],
  ['68元<活动价<72元',6801,7199],
  ['68.01元≤折后价<72.05元',6801,7204],
  ['活动价不得低于68元且不得高于72元',6800,7200],
 ]){
  const parsed=pricing.parsePriceConstraint(text);
  assert.deepEqual(parsed&&[parsed.minFen,parsed.maxFen],[minFen,maxFen],text);
 }
});

test('incomplete, malformed, coupon and unrelated numeric statements remain untrusted',()=>{
 for(const text of [
  '活动价不得低于近15天最低价','近15天最低价68元','活动价不得低于近15天最低价（元）',
  '活动价不得低于近15天最低价（68元','活动价不得低于近15天最低价68元）',
  '活动价不得高于近15天最低价（68元','活动价不得高于近15天最低价(68元）',
  '券后活动价不得低于近15天最低价（68元）','预估最低到手价15元，存在低价风险',
  '活动价不能高于68元，也不能低于未知金额','活动价不得低于68元且不得高于未知金额',
  '68元≤活动价≤72元或其他条件','68元≤活动价','活动价不得低于近15天最低价（68.001元）',
 ])assert.equal(pricing.parsePriceConstraint(text),null,text);
});

test('separate exact restrictions intersect without discarding a floor or a cap',()=>{
 assert.equal(typeof pricing.combinePriceConstraints,'function');
 const bounds=pricing.combinePriceConstraints(['活动价不得低于近15天最低价（68元）','活动价不得低于69元','活动价必须低于72元','4.5折≤折扣≤7.5折']);
 assert.deepEqual(bounds,{minFen:6900,maxFen:7199,minDiscount:45,maxDiscount:75});
 assert.throws(()=>pricing.combinePriceConstraints(['活动价不得低于68元','其他价格限制']),{code:'PRICE_RULE_UNKNOWN'});
 assert.deepEqual(pricing.combinePriceConstraints([]),{});
});

test('the nearest allowed 0.1-discount step is calculated in either direction without changing input',()=>{
 assert.equal(typeof pricing.selectClosestPriceStep,'function');
 const sku=Object.freeze({baseFen:13900,discount:50}),floor=Object.freeze({minFen:7000}),cap=Object.freeze({maxFen:6800});
 const up=pricing.selectClosestPriceStep(sku,floor),down=pricing.selectClosestPriceStep(sku,cap);
 assert.deepEqual([up.discount,up.saleFen,up.deltaFen],[51,7089,139]);
 assert.deepEqual([down.discount,down.saleFen,down.deltaFen],[48,6672,-278]);
 assert.deepEqual(sku,{baseFen:13900,discount:50});assert.deepEqual(floor,{minFen:7000});
 for(const bounds of [{},{minFen:6900,maxFen:7000},{minDiscount:45,maxDiscount:50}]){
  const result=pricing.selectClosestPriceStep(sku,bounds);
  assert.deepEqual([result.discount,result.saleFen,result.deltaFen],[50,6950,0]);
  assert.equal('approved' in result,false);assert.equal('originalRiskAllowed' in result,false);
 }
});

test('no solution is reported for conflicting rules, unrepresentable steps and template bounds',()=>{
 assert.equal(typeof pricing.selectClosestPriceStep,'function');
 for(const bounds of [{minFen:7000,maxFen:6999},{minFen:7000,maxFen:7050},{minDiscount:96},{maxDiscount:9},{minDiscount:60,maxDiscount:59},{maxFen:0}])
  assert.throws(()=>pricing.selectClosestPriceStep({baseFen:13900,discount:50},bounds),{code:'NO_FEASIBLE_PRICE'});
 for(const bounds of [{minFen:NaN},{maxFen:Infinity},{minFen:6800.1},{minDiscount:50.1},{maxDiscount:'50'},{unrecognized:42}])
  assert.throws(()=>pricing.selectClosestPriceStep({baseFen:13900,discount:50},bounds),{code:'PRICE_RULE_UNKNOWN'});
});

test('strict one-fen limits and rounding use the platform integer-fen price at each step',()=>{
 assert.equal(typeof pricing.selectClosestPriceStep,'function');
 const at=pricing.selectClosestPriceStep({baseFen:101,discount:50},{minFen:51,maxFen:51});
 const above=pricing.selectClosestPriceStep({baseFen:101,discount:50},{minFen:52});
 const below=pricing.selectClosestPriceStep({baseFen:101,discount:50},{maxFen:50});
 assert.deepEqual([at.discount,at.saleFen],[50,51]);
 assert.deepEqual([above.discount,above.saleFen],[51,52]);
 assert.deepEqual([below.discount,below.saleFen],[49,50]);
 assert.equal(pricing.selectClosestPriceStep({baseFen:1,discount:50},{minDiscount:51}).discount,51);
});

test('large amounts, fractional-yuan rounding and template edges retain the closest legal discount',()=>{
 assert.equal(typeof pricing.selectClosestPriceStep,'function');
 for(const [sku,bounds,discount,saleFen] of [
  [{baseFen:100000000,discount:50},{minFen:50000001},51,51000000],
  [{baseFen:100000000,discount:50},{maxFen:49999999},49,49000000],
  [{baseFen:13900,discount:95},{maxFen:13204},94,13066],
  [{baseFen:13900,discount:10},{minFen:1391},11,1529],
  [{baseFen:13900,discount:50},{minDiscount:52,maxDiscount:60},52,7228],
  [{baseFen:105,discount:50},{minFen:54},51,54],
  [{baseFen:149,discount:50},{minFen:76},51,76],
 ]){
  const result=pricing.selectClosestPriceStep(sku,bounds);
  assert.deepEqual([result.discount,result.saleFen],[discount,saleFen],JSON.stringify({sku,bounds}));
 }
});
