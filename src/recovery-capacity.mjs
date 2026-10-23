import {GuardError,requireThat} from './policy.mjs';

export const RECOVERY_MAX_PRODUCTS=50;
export const RECOVERY_MAX_SKUS=500;

// Execution budgets belong to the program, not to the platform's pricing
// rules. Count complete current plans; immutable history may contain more
// SKUs than a permitted, independently verified current subset.
export function assertRecoveryCapacity(plans){
 requireThat(Array.isArray(plans)&&plans.length>0&&plans.every(p=>Array.isArray(p?.skus)&&p.skus.length>0),
  'RESTORE_CAPACITY_INPUT','执行批次的完整规格尚未核对');
 const productCount=plans.length,skuCount=plans.reduce((n,p)=>n+p.skus.length,0);
 const restoreCapacity={source:'program-execution-budget',productCount,skuCount,maxProducts:RECOVERY_MAX_PRODUCTS,maxSkus:RECOVERY_MAX_SKUS,
  productIds:plans.map(p=>p.productId)};
 if(productCount>RECOVERY_MAX_PRODUCTS)throw new GuardError('RESTORE_PRODUCT_BUDGET',
  `本次恢复含${productCount}件商品，超过程序每批${RECOVERY_MAX_PRODUCTS}件的执行容量，须重新分组；尚未提交。`,{restoreCapacity});
 if(skuCount>RECOVERY_MAX_SKUS)throw new GuardError('RESTORE_SKU_BUDGET',
  `本次恢复含${skuCount}个当前规格，超过程序每批${RECOVERY_MAX_SKUS}个规格的执行容量；完整规格及历史已保留，其他商品继续核对。`,{restoreCapacity});
 return restoreCapacity;
}
