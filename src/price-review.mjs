import {fingerprint,normalizeName,requireThat,saleFen,proveDraft} from './policy.mjs';

function fen(value) {
  const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  requireThat(m,'PRICE_RULE_UNKNOWN','平台限制中的金额无法精确识别');
  const amount=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));
  requireThat(Number.isSafeInteger(amount)&&amount>0&&amount<=100000000,'PRICE_RULE_UNKNOWN','平台限制中的金额无效');
  return amount;
}

// Parse only complete, observed price statements. A day count, coupon risk,
// marketing prose or a product-level warning is not a SKU price bound.
export function parsePriceConstraint(text) {
  const s=String(text).replace(/\s+/g,'');
  let m=s.match(/^单品活动价[¥￥]\d+(?:\.\d{1,2})?[，,]需≤[¥￥](\d+(?:\.\d{1,2})?)[。！!]?$/);
  if(m)return {maxFen:fen(m[1]),evidence:text};
  m=s.match(/^(?:活动价格|活动价|折后价)(?:不得高于|不能高于|不高于|小于等于|≤)(?:近|最近)15天(?:内)?最低(?:生效标)?价[（(：:][¥￥]?(\d+(?:\.\d{1,2})?)元[）)]?[。！!]?$/);
  if(m)return {maxFen:fen(m[1]),rule:'lowest15days',evidence:text};
  const patterns=[
    [/^(?:活动价格|活动价|折后价|价格)(?:不得高于|不能高于|不高于|小于等于|≤)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/,'maxFen',0],
    [/^(?:活动价格|活动价|折后价|价格)(?:必须低于|需低于|小于|<)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/,'maxFen',-1],
    [/^(?:活动价格|活动价|折后价|价格)(?:不得低于|不能低于|不低于|大于等于|≥)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/,'minFen',0],
    [/^(?:活动价格|活动价|折后价|价格)(?:必须高于|需高于|大于|>)[¥￥]?(\d+(?:\.\d{1,2})?)元[。！!]?$/,'minFen',1]
  ];
  for(const [regex,key,offset] of patterns){m=s.match(regex);if(m)return {[key]:fen(m[1])+offset,evidence:text};}
  m=s.match(/^(\d(?:\.\d)?)折≤折扣≤(\d(?:\.\d)?)折[。！!]?$/);
  if(m)return {minDiscount:Math.round(Number(m[1])*10),maxDiscount:Math.round(Number(m[2])*10),evidence:text};
  m=s.match(/^(?:活动)?折扣(?:不得高于|不能高于|不高于|小于等于|≤)(\d(?:\.\d)?)折[。！!]?$/);
  return m?{maxDiscount:Math.round(Number(m[1])*10),evidence:text}:null;
}

export function makePriceReviews(task,probe,now=Date.now()) {
  requireThat(probe?.source==='live-platform-draft'&&probe.kind==='draft'&&probe.dialogs?.length===0,
    'PRICE_REVIEW_EVIDENCE','调价建议必须来自本次独立草稿的完整直接读取');
  // Verify that only the already-authorized prices were entered. Never probe
  // lower candidates in the platform before the human confirms the table.
  proveDraft(task,{...probe,warnings:[]},now);
  const errors=new Set(probe.rows.flatMap(r=>r.errors||[]));
  requireThat(errors.size>0&&(probe.warnings||[]).every(w=>errors.has(w)),
    'PRICE_RULE_UNKNOWN','存在未能对应具体规格的平台提示');
  const reviews=[];
  for(const plan of task.plans){
    const rows=plan.skus.map(sku=>{
      const observed=probe.rows.find(r=>r.productId===plan.productId&&r.id===sku.id),bounds={},evidence=[];
      for(const error of observed.errors||[]){
        const parsed=parsePriceConstraint(error);
        requireThat(parsed,'PRICE_RULE_UNKNOWN',`${sku.name}：平台提示没有明确可计算的价格范围`);
        evidence.push(error);
        for(const key of ['minFen','maxFen','minDiscount','maxDiscount'])if(parsed[key]!=null)
          bounds[key]=bounds[key]==null?parsed[key]:(key.startsWith('min')?Math.max:Math.min)(bounds[key],parsed[key]);
      }
      let discount=null;
      for(let d=sku.discount;d>=10;d--){
        const price=saleFen(sku.baseFen,d);
        if(d<=95&&d>=(bounds.minDiscount??10)&&d<=(bounds.maxDiscount??95)&&price>=(bounds.minFen??1)&&price<=(bounds.maxFen??Infinity)){discount=d;break;}
      }
      requireThat(discount!==null,'NO_FEASIBLE_PRICE',`${sku.name}：明确的上下限内没有可用折扣`);
      if(discount<sku.discount)requireThat(bounds.maxFen!=null||bounds.maxDiscount!=null,'PRICE_BOUND_UNKNOWN','缺少明确价格上限');
      return {id:sku.id,name:normalizeName(sku.name),baseFen:sku.baseFen,historicalDiscount:sku.originalDiscount??sku.discount,
        previousDiscount:sku.discount,previousFen:sku.saleFen,discount,saleFen:saleFen(sku.baseFen,discount),bounds,evidence};
    });
    if(!rows.some(r=>r.discount<r.previousDiscount))continue;
    const value={shopId:task.shopId,productId:plan.productId,name:plan.name,historicalFingerprint:plan.historicalFingerprint,
      previousApprovalId:plan.priceApprovalId||null,type:plan.type,rules:structuredClone(plan.rules),skippedSkuIds:[...plan.skippedSkuIds],rows};
    reviews.push({...value,key:fingerprint(value),source:'live-platform-draft',taskId:task.id,createdAt:now,expiresAt:now+30*60000,status:'pending'});
  }
  requireThat(reviews.length,'PRICE_RULE_UNKNOWN','当前提示未得到明确的进一步降价建议');
  return reviews;
}

// The immutable platform history is never rewritten. An approval is a separate
// exact target, valid only for the same historical source and matching SKUs.
export function applyPriceTarget(original,review) {
  if(!review||review.status!=='approved'||review.shopId!==original.shopId||review.productId!==original.productId||review.historicalFingerprint!==original.historicalFingerprint)return original;
  const {fingerprint:oldFingerprint,...base}=original;
  let changed=false;
  const skus=original.skus.map(sku=>{
    const row=review.rows.find(r=>r.id===sku.id);if(!row)return sku;
    requireThat(row.name===normalizeName(sku.name)&&row.baseFen===sku.baseFen&&row.historicalDiscount===sku.discount&&
      Number.isInteger(row.discount)&&row.discount>=10&&row.discount<=sku.discount&&row.saleFen===saleFen(sku.baseFen,row.discount),
      'PRICE_APPROVAL_CHANGED','已确认价格与当前规格或历史发生变化');
    changed=changed||row.discount<sku.discount;
    return {...sku,originalDiscount:sku.discount,discount:row.discount,saleFen:row.saleFen};
  });
  // Retain the previous approval identity even when its reduced SKU is absent.
  // Any further proposal must still be linked to the target the human saw.
  const result={...base,skus,originalRiskAllowed:changed?false:original.originalRiskAllowed,approvedRiskAllowed:changed,priceApprovalId:review.id,priceApprovalKey:review.key};
  return {...result,fingerprint:fingerprint(result)};
}

