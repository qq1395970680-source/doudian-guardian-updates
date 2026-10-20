import {requireThat} from './policy.mjs';
import {parsePriceConstraint} from './price-constraints.mjs';

const summary=text=>typeof text==='string'&&text.replace(/\s+/g,'')==='部分规格打折填写错误。立即收起';

// The product-level banner repeats its SKU errors. It may be removed only
// from a proposal probe, with a numeric constraint on that same product.
// Submission proofs still require a completely clean draft.
export function draftPriceWarnings(products,warnings,{priceReview=false}={}){
  let matchedSummary=false;
  for(const product of products){
    const skuErrors=product.skus.flatMap(s=>s.errors||[]);
    const productErrors=product.errors||[];
    const allowed=priceReview&&skuErrors.some(text=>parsePriceConstraint(text));
    requireThat(productErrors.every(text=>allowed&&summary(text))&&
      (priceReview||skuErrors.length===0),'DRAFT_WARNING','商品或规格有未解决的价格提示');
    matchedSummary=matchedSummary||productErrors.length>0;
  }
  return warnings.filter(text=>!(priceReview&&matchedSummary&&summary(text)));
}
