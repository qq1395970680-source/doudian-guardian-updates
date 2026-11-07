// Omitted modes retain the original discount contract and its fingerprints.
// A fixed price is an exact integer number of fen, never a derived discount.
function check(value,code,message){if(!value)throw Object.assign(new Error(message),{code});}
export function priceMode(value){
 const mode=value?.priceMode;
 check(mode===undefined||mode==='discount'||mode==='fixed','PRICE_MODE_UNKNOWN','价格方式不明确，不能猜测为折扣或一口价');
 return mode==='fixed'?'fixed':'discount';
}
export const priceModeFields=value=>priceMode(value)==='fixed'?{priceMode:'fixed'}:{};
export function fixedActivityMaxFen(sku){
 check(Number.isSafeInteger(sku?.baseFen)&&sku.baseFen>0&&sku.baseFen<=100000000,'INVALID_PRICE','一口价的商品原价必须为有效整数分');
 // Capability is still established from the fresh official template before
 // import. This is its verified maximum, not a discount approximation or
 // authority to reduce an existing fixed-price target.
 return Math.floor(sku.baseFen*95/100);
}
export function validateFixedPrice(sku){
 check(Number.isSafeInteger(sku?.baseFen)&&sku.baseFen>0&&sku.baseFen<=100000000,'INVALID_PRICE','一口价的商品原价必须为有效整数分');
 check(sku.discount===null,'FIXED_PRICE_DISCOUNT','一口价不得携带折扣或换算成近似折扣');
 check(Number.isSafeInteger(sku.saleFen)&&sku.saleFen>0&&sku.saleFen<=sku.baseFen,'INVALID_PRICE','一口价必须是大于零且不高于商品原价的确切整数分');
 return sku.saleFen;
}
export function expectedSaleFen(sku,context=sku){
 const mode=priceMode(context);
 check(sku?.priceMode===undefined||priceMode(sku)===mode,'PRICE_MODE_CHANGED','规格价格方式与本次活动不一致');
 if(mode==='fixed')return validateFixedPrice(sku);
 check(Number.isSafeInteger(sku?.baseFen)&&sku.baseFen>0&&sku.baseFen<=100000000,'INVALID_PRICE','原价必须为有效的整数分');
 check(Number.isInteger(sku.discount)&&sku.discount>=10&&sku.discount<=99,'INVALID_DISCOUNT','折扣必须为原价的整数百分比');
 return Math.floor((sku.baseFen*sku.discount+99)/100);
}
export function assertSamePriceMode(left,right){
 check(priceMode(left)===priceMode(right),'PRICE_MODE_CHANGED','一口价和打折模式不能相互替换或混入同一活动');
 return priceMode(left);
}
