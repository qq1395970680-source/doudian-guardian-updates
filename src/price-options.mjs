import {fingerprint,saleFen} from './policy.mjs';
import {selectRatioPrices,describeRatio} from './ratio-prices.mjs';
import {selectClosestPriceStep} from './price-constraints.mjs';
import {campaignChoice} from './campaign-choice.mjs';

const cache=new Map();
const descriptions=[
 ['original','原算法方案','保留原算法的建议；可能包含降价，需明确确认。'],
 ['raise-low','只提高低价规格','保持当前最高价规格不变，只提高其他规格的折后价。'],
 ['balanced','综合建议方案','所有规格均不降价，同时满足已读限制，尽量减少总涨价金额。']
];
export function priceOptions(review){
 const cacheKey=fingerprint({key:review.key,rows:review.rows,ratio:review.ratio||null,type:review.type,campaignTarget:review.campaignTarget||null});
 if(cache.has(cacheKey))return structuredClone(cache.get(cacheKey));
 const skus=review.rows.map(row=>({id:row.id,baseFen:row.baseFen,discount:row.previousDiscount,saleFen:row.previousFen}));
 const highest=Math.max(...skus.map(row=>row.saleFen));
 const options=descriptions.map(([id,label,description])=>{
  try{
   let rows=structuredClone(review.rows),ratio=review.ratio;
   if(id!=='original'){
    const bounds=review.rows.map(row=>({...row.bounds,minFen:Math.max(row.previousFen,row.bounds?.minFen??0),
     ...(id==='raise-low'&&row.previousFen===highest?{maxFen:Math.min(row.previousFen,row.bounds?.maxFen??Infinity)}:{})}));
    const selected=ratio?selectRatioPrices(skus,ratio,bounds):skus.map((sku,i)=>selectClosestPriceStep(sku,bounds[i]));
    rows=rows.map((row,i)=>({...row,discount:selected[i].discount,saleFen:selected[i].saleFen}));
    if(ratio)ratio=describeRatio(skus,rows,ratio);
   }
   return{id,label,description,available:true,rows,...(ratio?{ratio}:{}),
    validationStatus:'candidate',activityType:review.type,
    key:fingerprint({algorithm:'price-strategies-v1',sourceKey:review.key,id,rows,ratio:ratio||null})};
  }catch(error){
   if(error.code!=='NO_FEASIBLE_PRICE')throw error;
   return{id,label,description,available:false,rows:[],reason:'在当前商品原价、可用折扣档位和已读平台价格上下限内，没有满足条件的不降价方案。程序不会改商品原价或绕过平台限制。'};
  }
 });
 if(['限量抢购','限时抢购'].includes(review.type)){
  const target=campaignChoice(review.type==='限量抢购'?'限时抢购':'限量抢购');
  const rows=review.rows.map(row=>({...row,discount:row.historicalDiscount,saleFen:saleFen(row.baseFen,row.historicalDiscount),
   bounds:{},evidence:['保留原历史折扣；另一种活动的价格限制需重新由平台校验。']}));
  options.push({id:'switch-original',label:'原折扣 · 切换'+target.type,
   description:target.type==='限时抢购'?'保留历史折扣，改为48小时限时抢购，不限量、不限购、不预热，30分钟取消订单。':'保留历史折扣，改为7天限量抢购，共用1000件、不限购、不预热、30分钟取消订单、自动续期。',
   available:true,validationStatus:'unverified',activityType:target.type,campaignTarget:target,rows,
   reason:'尚未通过目标活动的实时草稿校验。切换类型不代表免除价格限制；确认后先核验，受阻会记录原因，不会作废现有有效活动。',
   key:fingerprint({algorithm:'campaign-switch-original-v1',sourceKey:review.key,target,rows})});
 }
 for(let i=0;i<options.length;i++){
  if(!options[i].available)continue;
  const same=options.slice(0,i).find(other=>other.available&&fingerprint(other.rows)===fingerprint(options[i].rows));
  if(same)options[i].sameAs=same.label;
 }
 if(cache.size>=100)cache.delete(cache.keys().next().value);
 cache.set(cacheKey,structuredClone(options));return options;
}
