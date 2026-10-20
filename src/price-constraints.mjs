import {requireThat,saleFen} from './policy.mjs';

const boundKeys=['minFen','maxFen','minDiscount','maxDiscount'];
const relations=new Map([
 ...['不得高于','不能高于','不高于','小于等于','≤'].map(s=>[s,['maxFen',0]]),
 ...['必须低于','需低于','小于','<'].map(s=>[s,['maxFen',-1]]),
 ...['不得低于','不能低于','不低于','大于等于','≥'].map(s=>[s,['minFen',0]]),
 ...['必须高于','需高于','大于','>'].map(s=>[s,['minFen',1]])
]);

function fen(value) {
 const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
 requireThat(m,'PRICE_RULE_UNKNOWN','平台限制中的金额无法精确识别');
 const amount=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));
 requireThat(Number.isSafeInteger(amount)&&amount>0&&amount<=100000000,'PRICE_RULE_UNKNOWN','平台限制中的金额无效');
 return amount;
}

// Pure interpretation, never price approval. Only a complete statement with
// an explicit SKU price bound is accepted; the 15-day count is not an amount.
export function parsePriceConstraint(text) {
 if(typeof text!=='string')return null;
 const s=text.replace(/\s+/g,'');
 let m=s.match(/^单品活动价[¥￥]\d+(?:\.\d{1,2})?[，,]需([≤≥<>])[¥￥](\d+(?:\.\d{1,2})?)[。！!]?$/);
 if(m){const [key,offset]=relations.get(m[1]);return {[key]:fen(m[2])+offset,evidence:text};}
 m=s.match(/^(?:活动价格|活动价|折后价)(不得高于|不能高于|不高于|小于等于|≤|必须低于|需低于|小于|<|不得低于|不能低于|不低于|大于等于|≥|必须高于|需高于|大于|>)(?:近|最近)15天(?:内)?最低(?:生效标)?价([（(：:])[¥￥]?(\d+(?:\.\d{1,2})?)元([）)])?[。！!]?$/);
 if(m){
  if(({'（':'）','(':')','：':'',':':''}[m[2]])!==(m[4]||''))return null;
  const [key,offset]=relations.get(m[1]);
  return {[key]:fen(m[3])+offset,rule:'lowest15days',evidence:text};
 }
 m=s.match(/^(?:活动价格|活动价|折后价|价格)(不得高于|不能高于|不高于|小于等于|≤|必须低于|需低于|小于|<|不得低于|不能低于|不低于|大于等于|≥|必须高于|需高于|大于|>)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/);
 if(m){const [key,offset]=relations.get(m[1]);return {[key]:fen(m[2])+offset,evidence:text};}
 m=s.match(/^[¥￥]?(\d+(?:\.\d{1,2})?)元([≤<])(?:活动价格|活动价|折后价)([≤<])[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/);
 if(m)return {minFen:fen(m[1])+(m[2]==='<'?1:0),maxFen:fen(m[4])-(m[3]==='<'?1:0),evidence:text};
 m=s.match(/^(?:活动价格|活动价|折后价)(不得低于|不能低于|不低于|必须高于|需高于)[¥￥]?(\d+(?:\.\d{1,2})?)元且(不得高于|不能高于|不高于|必须低于|需低于)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/);
 if(m)return {minFen:fen(m[2])+relations.get(m[1])[1],maxFen:fen(m[4])+relations.get(m[3])[1],evidence:text};
 m=s.match(/^(\d(?:\.\d)?|10(?:\.0)?)折≤折扣≤(\d(?:\.\d)?|10(?:\.0)?)折[。！!]?$/);
 if(m)return {minDiscount:Math.round(Number(m[1])*10),maxDiscount:Math.round(Number(m[2])*10),evidence:text};
 m=s.match(/^(?:活动)?折扣(?:不得高于|不能高于|不高于|小于等于|≤)(\d(?:\.\d)?|10(?:\.0)?)折[。！!]?$/);
 return m?{maxDiscount:Math.round(Number(m[1])*10),evidence:text}:null;
}

export function combinePriceConstraints(statements) {
 requireThat(Array.isArray(statements),'PRICE_RULE_UNKNOWN','平台价格限制必须为完整语句集合');
 const bounds={};
 for(const statement of statements){
  const parsed=parsePriceConstraint(statement);
  requireThat(parsed,'PRICE_RULE_UNKNOWN','平台提示没有明确可计算的价格范围');
  for(const key of boundKeys)if(parsed[key]!=null)
   bounds[key]=bounds[key]==null?parsed[key]:(key.startsWith('min')?Math.max:Math.min)(bounds[key],parsed[key]);
 }
 return bounds;
}

// Calculate a proposal only. This function cannot authorize, fill, submit or
// persist a price; execution must independently validate its approval path.
export function selectClosestPriceStep(sku,bounds={}) {
 const previousFen=saleFen(sku?.baseFen,sku?.discount);
 requireThat(sku.discount<=95,'TEMPLATE_RANGE','原折扣超出已验证官方导入模板范围');
 requireThat(bounds&&typeof bounds==='object'&&!Array.isArray(bounds)&&Object.entries(bounds).every(([key,value])=>
  boundKeys.includes(key)&&Number.isSafeInteger(value)&&value>=0),'PRICE_RULE_UNKNOWN','价格上下限必须为明确整数值');
 let discount=null,price=null;
 for(let d=10;d<=95;d++){
  const candidate=saleFen(sku.baseFen,d);
  if(d<(bounds.minDiscount??10)||d>(bounds.maxDiscount??95)||candidate<=0||candidate<(bounds.minFen??1)||candidate>(bounds.maxFen??Infinity))continue;
  if(discount===null||Math.abs(d-sku.discount)<Math.abs(discount-sku.discount)||
   Math.abs(d-sku.discount)===Math.abs(discount-sku.discount)&&d>discount){discount=d;price=candidate;}
 }
 requireThat(discount!==null,'NO_FEASIBLE_PRICE','明确的上下限内没有可用折扣');
 return {previousDiscount:sku.discount,previousFen,discount,saleFen:price,deltaFen:price-previousFen};
}
