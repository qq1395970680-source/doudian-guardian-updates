import {fingerprint,normalizeName,requireThat,saleFen} from './policy.mjs';
import {parseRemovalPriceRatio} from './removal-export.mjs';

// Enumerate possible minimum prices, not combinations of SKU discounts.
// Every feasible set has a minimum in this set. For a fixed interval each SKU
// independently picks its nearest step, so this covers the global optimum.
export function selectRatioPrices(skus,ratio,bounds=null){
 requireThat(Array.isArray(skus)&&skus.length>0&&skus.length<=10000&&new Set(skus.map(s=>s.id)).size===skus.length,
  'PRICE_REVIEW_EVIDENCE','倍率建议需要非空且唯一的完整规格');
 const {numerator:n,denominator:d}=ratio||{};
 requireThat(Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&d>0&&d<=1000&&n>=d&&n<=1000*d,
  'REMOVAL_RULE_UNKNOWN','倍率限制无效');
 bounds??=skus.map(()=>({}));
 requireThat(Array.isArray(bounds)&&bounds.length===skus.length&&bounds.every(b=>b&&typeof b==='object'&&!Array.isArray(b)&&
  Object.entries(b).every(([k,v])=>['minFen','maxFen','minDiscount','maxDiscount'].includes(k)&&Number.isSafeInteger(v)&&v>=0)),
  'PRICE_RULE_UNKNOWN','逐规格价格范围不完整');
 const ranges=skus.map((s,i)=>{
  requireThat(s.discount<=95&&s.saleFen===saleFen(s.baseFen,s.discount),'PRICE_REVIEW_EVIDENCE','已有守护价不一致');
  const b=bounds[i],low=Math.max(10,b.minDiscount??10,Math.ceil(((b.minFen??1)*100-50)/s.baseFen));
  const high=Math.min(95,b.maxDiscount??95,b.maxFen==null?95:Math.floor((b.maxFen*100+49)/s.baseFen));
  requireThat(low<=high,'NO_FEASIBLE_PRICE','逐规格价格范围内没有可用折扣');
  return {low,high,values:Array.from({length:high-low+1},(_,j)=>saleFen(s.baseFen,j+low))};
 });
 const values=ranges.map(r=>r.values);
 const feasibleLow=Math.ceil(Math.max(...values.map(row=>row[0]))*d/n);
 const feasibleHigh=Math.min(...values.map(row=>row.at(-1)));
 const minimums=[...new Set(values.flat())].filter(p=>p>=feasibleLow&&p<=feasibleHigh).sort((a,b)=>a-b);
 let best=null;
 for(const minimum of minimums){
  const maximum=Math.floor(minimum*n/d),rows=[];
  let absolute=0,reductions=0,steps=0,changed=0,feasible=true;
  for(let i=0;i<skus.length;i++){
   const s=skus[i],range=ranges[i];
   // Integer inversion of round(base * discount / 100), including half-cent
   // boundaries. Never use floating-point equality to approve a ratio.
   const low=Math.max(range.low,Math.ceil((minimum*100-50)/s.baseFen));
   const high=Math.min(range.high,Math.floor((maximum*100+49)/s.baseFen));
   if(low>high){feasible=false;break;}
   const discount=Math.max(low,Math.min(high,s.discount)),price=saleFen(s.baseFen,discount);
   if(price<minimum||price>maximum){feasible=false;break;}
   const delta=price-s.saleFen;
   absolute+=Math.abs(delta);reductions+=Math.max(0,-delta);steps+=Math.abs(discount-s.discount);
   if(discount!==s.discount)changed++;
   rows.push({discount,saleFen:price});
  }
  if(!feasible)continue;
  // Prefer a solution without any price reduction. Within that class minimize
  // total absolute fen movement (equal SKU weights), then reductions and steps.
  const score=[Number(reductions>0),absolute,reductions,steps,changed];
  const better=!best||score.some((v,i)=>v<best.score[i]&&score.slice(0,i).every((x,j)=>x===best.score[j]));
  if(better)best={rows,score};
 }
 requireThat(best,'NO_FEASIBLE_PRICE','已验证折扣范围内没有满足倍率的方案，需先调整商品规格或平台规则');
 return best.rows;
}

export function validateRemovalPriceEvidence(plan,loss,now=Date.now()){
 const proof=loss?.removalEvidence,record=loss?.removal;
 const fresh=at=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
 requireThat(loss?.complete===true&&loss.active===false&&fresh(loss.observedAt)&&typeof loss.lossKey==='string'&&loss.lossKey.length>0&&
  proof?.source==='live-platform-removal-export'&&proof.complete===true&&proof.shopId===plan.shopId&&
  typeof proof.campaignId==='string'&&/^\d{3,25}$/.test(proof.campaignId)&&fresh(proof.observedAt)&&
  /^[a-f0-9]{64}$/.test(proof.sha256)&&record?.productId===plan.productId&&fingerprint(record)===fingerprint(proof.record),
  'PRICE_REVIEW_EVIDENCE','倍率建议必须来自本轮匹配店铺和商品的完整平台剔除明细');
 return parseRemovalPriceRatio(record.reason);
}

export function describeRatio(skus,rows,ratio){
 const previous=skus.map(s=>s.saleFen),proposed=rows.map(r=>r.saleFen);
 return {...ratio,previousMinFen:Math.min(...previous),previousMaxFen:Math.max(...previous),
  proposedMinFen:Math.min(...proposed),proposedMaxFen:Math.max(...proposed),
  lowerSkuCount:rows.filter((r,i)=>r.saleFen<skus[i].saleFen).length,
  algorithm:'prefer-no-reductions-then-minimum-total-absolute-fen-equal-sku-weights'};
}

export function makeRemovalPriceReview(plan,loss,now=Date.now()){
 const ratio=validateRemovalPriceEvidence(plan,loss,now),proof=loss.removalEvidence,record=loss.removal;
 const {fingerprint:planHash,...material}=plan;
 const fresh=at=>Number.isFinite(at)&&at>0&&at<=now+5000&&now-at<=120000;
 requireThat(fresh(plan.observedAt)&&planHash===fingerprint(material),'PRICE_REVIEW_EVIDENCE','当前规格计划已变化或过期');
 const previous=plan.skus.map(s=>s.saleFen);
 requireThat(Math.max(...previous)*ratio.denominator>Math.min(...previous)*ratio.numerator,
  'PRICE_REVIEW_UNNEEDED','当前守护价格已满足倍率，无需生成调整建议');
 const selected=selectRatioPrices(plan.skus,ratio);
 const rows=plan.skus.map((sku,i)=>({id:sku.id,name:normalizeName(sku.name),baseFen:sku.baseFen,
  historicalDiscount:sku.originalDiscount??sku.discount,previousDiscount:sku.discount,previousFen:sku.saleFen,
  ...selected[i],bounds:{},evidence:[record.reason]}));
 const rule=describeRatio(plan.skus,rows,ratio);
 const value={kind:'sku-price-ratio',shopId:plan.shopId,productId:plan.productId,name:plan.name,
  historicalFingerprint:plan.historicalFingerprint,previousApprovalId:plan.priceApprovalId||null,
  type:plan.type,rules:structuredClone(plan.rules),skippedSkuIds:[...plan.skippedSkuIds],rows,ratio:rule};
 return {...value,key:fingerprint(value),source:'live-platform-removal-export',taskId:null,
  sourceProof:{...structuredClone(proof),planFingerprint:planHash,lossKey:loss.lossKey},
  createdAt:now,expiresAt:now+30*60000,status:'pending'};
}
