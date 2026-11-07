// Display helpers only. The server independently validates every exact amount.
export const isFixedPrice=value=>value?.priceMode==='fixed';
export const priceModeLabel=value=>isFixedPrice(value)?'一口价':'按折扣';
export function inputMoneyFen(value){
 const text=String(value??'').trim();
 if(!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text))return null;
 const [yuan,cents='']=text.split('.'),fen=Number(yuan)*100+Number(cents.padEnd(2,'0'));
 return Number.isSafeInteger(fen)&&fen>0&&fen<=100000000?fen:null;
}
export const moneyInputValue=fen=>Number.isSafeInteger(fen)?(fen/100).toFixed(2):'';
export function largestReductionPercent(rows){
 const rates=rows.filter(row=>Number.isSafeInteger(row.previousFen)&&row.previousFen>0&&Number.isSafeInteger(row.saleFen)&&row.saleFen<row.previousFen).map(row=>(row.previousFen-row.saleFen)*100/row.previousFen);
 return rates.length?Math.max(...rates).toFixed(1):null;
}
