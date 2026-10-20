import test from 'node:test';
import assert from 'node:assert/strict';
import {draftPriceWarnings} from '../src/draft-price-warnings.mjs';

const banner='部分规格打折填写错误。\n立即收起';
const cap='单品活动价￥22.4，需≤￥16.8';
const product=(errors=[banner],skuErrors=[cap])=>({errors,skus:[{errors:skuErrors}]});
test('a product summary with a same-product numeric SKU error reaches review without dropping that bound',()=>{
  const products=[product()],warnings=[banner,cap];
  assert.deepEqual(draftPriceWarnings(products,warnings,{priceReview:true}),[cap]);
  assert.deepEqual(products[0].errors,[banner]);
  assert.deepEqual(warnings,[banner,cap]);
});
test('the same summary and numeric error cannot pass a submit-time draft check',()=>{
  assert.throws(()=>draftPriceWarnings([product()],[banner,cap]),{code:'DRAFT_WARNING'});
});
test('summary without a numeric SKU constraint is blocked, including unknown or empty SKU errors',()=>{
  for(const errors of [[],['存在未识别的提示']])
    assert.throws(()=>draftPriceWarnings([product([banner],errors)],[banner],{priceReview:true}),{code:'DRAFT_WARNING'});
});
test('another product cannot supply the missing numeric evidence for a summary',()=>{
  assert.throws(()=>draftPriceWarnings([product([banner],[]),product([], [cap])],[banner,cap],{priceReview:true}),{code:'DRAFT_WARNING'});
});
test('unknown product and global warnings remain blocking evidence',()=>{
  assert.throws(()=>draftPriceWarnings([product(['不允许参加活动'])],[cap],{priceReview:true}),{code:'DRAFT_WARNING'});
  assert.deepEqual(draftPriceWarnings([product()],[banner,cap,'其他未解析的价格提示'],{priceReview:true}),[cap,'其他未解析的价格提示']);
  assert.deepEqual(draftPriceWarnings([product([], [cap])],[banner,cap],{priceReview:true}),[banner,cap]);
});
test('clean drafts remain clean',()=>{
  assert.deepEqual(draftPriceWarnings([product([],[])],[]),[]);
});
