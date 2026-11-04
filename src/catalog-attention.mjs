import {fingerprint} from './policy.mjs';
import {verifiedRecoveryReceipt} from './recovery-history.mjs';

// An index of known unfinished work for display. It is deliberately separate
// from catalog.state/current and must never be used as recovery evidence.
export function withCatalogAttention({shopId,catalog,ownership,reviews=[],checks=[],requests=[],tasks=[],dualDecisions=new Map(),hiddenProductIds=[],now=Date.now()}={}){
 if(!catalog)return catalog;
 const hidden=new Set(hiddenProductIds),books=new Map(),at=value=>Number.isFinite(value)&&value>0&&value<=now+5000?value:0;
 const book=productId=>{if(!books.has(productId))books.set(productId,{reviews:[],checks:[],requests:[],tasks:[],verifiedAt:0});return books.get(productId);};
 for(const review of reviews)if(review.shopId===shopId&&['pending','declined'].includes(review.status)&&at(review.createdAt))book(review.productId).reviews.push(review);
 for(const check of checks)if(check.shopId===shopId&&check.code&&at(check.at))book(check.productId).checks.push(check);
 for(const request of requests)if((!request.shopId||request.shopId===shopId)&&request.state!=='complete'&&at(request.requestedAt))book(request.productId).requests.push(request);
 for(const task of tasks){
  if(task.shopId!==shopId||!Array.isArray(task.plans))continue;
  const verified=verifiedRecoveryReceipt(task,shopId)&&at(task.receipt.verifiedAt);
  for(const productId of new Set(task.plans.filter(p=>p.shopId===shopId).map(p=>p.productId))){const b=book(productId);if(verified)b.verifiedAt=Math.max(b.verifiedAt,verified);else b.tasks.push(task);}
 }
 const waitingProductIds=[],readbackProductIds=[];
 const products=(catalog.products||[]).map(product=>{
  const {displayAttention:oldAttention,...p}=product;
  if(catalog.shopId!==shopId||p.excluded||hidden.has(p.productId)||['off-shelf','recycled','excluded'].includes(p.state))return p;
  const b=books.get(p.productId)||{reviews:[],checks:[],requests:[],tasks:[],verifiedAt:0},assignment=ownership?.byProduct?.get(p.productId),decision=dualDecisions.get(p.productId),unfinished=b.tasks.filter(t=>!['verified','blocked'].includes(t.phase));
  const hasPositive=p.state==='active'||p.state==='scheduled';
  if(hasPositive&&!unfinished.length)return p;
  const ledgerKnown=!!(assignment||b.reviews.length||b.checks.length||b.requests.length||b.tasks.some(t=>t.phase==='blocked')||p.removed?.length||at(decision?.createdAt));
  const known=unfinished.length>0||p.pending===true||p.state==='missing'||ledgerKnown;
  const reviewAt=Math.max(0,...b.reviews.map(r=>at(r.createdAt))),requestAt=Math.max(0,...b.requests.map(r=>at(r.requestedAt)));
  const lossAt=Math.max(0,...(p.removed||[]).map(r=>at(r.observedAt)),
   ...b.tasks.map(t=>t.lossEvidence?.complete===true&&t.lossEvidence.lossKey?at(t.lossEvidence.observedAt):0),
   ...b.checks.map(c=>c.lossKey?at(c.at):Math.max(at(c.limitedLoss?.export?.observedAt),at(c.timedLoss?.export?.observedAt),at(c.activeHintRemoval?.observedAt))));
  const absentAt=catalog.complete===true&&!p.current?.length&&!p.scheduled?.length&&p.history?at(catalog.listingObservedAt||catalog.observedAt):0;
  const newerWork=Math.max(reviewAt,requestAt,lossAt,absentAt,decision?.valid!==false?at(decision?.createdAt):0);
  const positiveAt=Math.max(0,...[...(p.current||[]),...(p.scheduled||[]),...(p.lastObserved||[])].filter(a=>Array.isArray(a.skus)&&a.skus.length>0).map(a=>at(a.observedAt)));
  if(b.verifiedAt&&!unfinished.length&&!p.pending&&newerWork<=b.verifiedAt){
   readbackProductIds.push(p.productId);
   return{...p,displayAttention:{waiting:false,kind:'readback',label:'已回读，目录更新中',verifiedAt:b.verifiedAt}};
  }
  if(positiveAt&&!unfinished.length&&!p.pending&&newerWork<=positiveAt)return{...p,displayAttention:{waiting:false,kind:'observed',label:'活动信息更新中',observedAt:positiveAt}};
  if(!known)return p;
  const unknown=unfinished.some(t=>['unknown','submitting','verifying'].includes(t.phase))||['unknown','submitting','verifying'].includes(p.pendingPhase);
  const freshReview=b.reviews.some(r=>r.status==='pending'&&Number.isFinite(r.expiresAt)&&r.expiresAt>now),priceConfirmation=assignment?.owner==='prices'&&freshReview&&decision?.requiresRevalidation!==true;
  const priceUpdating=!priceConfirmation&&(b.reviews.some(r=>r.status==='pending')||decision?.schemes?.some(s=>s.classification==='reduction-required'));
  const kind=unknown?'verification':unfinished.length||p.pending?'processing':priceConfirmation?'price-confirmation':priceUpdating?'price-updating':'recovery';
  const label={verification:'结果待核实',processing:'恢复处理中','price-confirmation':'等待价格确认','price-updating':'价格依据更新中',recovery:'等待核验恢复'}[kind];
  waitingProductIds.push(p.productId);return{...p,displayAttention:{waiting:true,kind,label}};
 });
 const attention={schema:1,source:'known-recovery-work-display',waitingProductIds,readbackProductIds,waitingCount:waitingProductIds.length};
 const {revision,...base}=catalog,result={...base,products,attention};return{...result,revision:fingerprint(result)};
}
