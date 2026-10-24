import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCatalog,catalogObservation} from '../src/catalog.mjs';
const now=1792437600000,shopId='900001';
const sku={id:'500001',name:'PP棉',baseFen:10000,discount:50,saleFen:5000,saleSource:'computed-from-verified-base-and-discount'};
const baseline={shopId,productId:'300001',name:'历史商品',campaignId:'400001',historyAt:now-100000,skus:[{...sku,discount:60,saleFen:6000}]};
const campaign={id:'400002',name:'当前活动',status:'进行中',startAt:now-50000,endAt:now+100000};
const inventory={listing:{complete:true,observedAt:now,campaigns:[campaign]},activeComplete:true,details:new Map([[campaign.id,{complete:true,observedAt:now-1000,products:[{productId:'300001',name:'当前商品',skus:[sku]}]}]])};
const base=()=>({shopId,inventory,histories:[baseline],tasks:[],excluded:[],now});

test('timed exit evidence failures expose the precise reason without counting a recovery or hiding a valid activity',()=>{
 const timedLoss={branch:'export-unproven',referenceCampaignId:'400003',exportError:{code:'REMOVAL_EXPORT_READ',message:'退出表下载失败'}};
 const check={shopId,productId:baseline.productId,code:'TIMED_LOSS_UNPROVEN',message:'对应限时活动退出明细未完整核对',at:now-1000,timedLoss};
 const missing={listing:{complete:true,observedAt:now,campaigns:[]},activeComplete:true,details:new Map()};
 const result=buildCatalog({...base(),inventory:missing,checks:[check]});
 assert.equal(result.counts.recoveryFailedProducts,1);assert.equal(result.counts.pendingProducts,0);
 assert.equal(result.products[0].recoveryFailure.stage,'eligibility');assert.deepEqual(result.products[0].recoveryFailure.timedLoss,timedLoss);
 assert.equal(buildCatalog({...base(),checks:[check]}).counts.recoveryFailedProducts,0);
});

test('pre-enqueue failures expose counts and retry time without claiming recovery or overriding current activity',()=>{
 const check={shopId,productId:baseline.productId,code:'PRECHECK_MEMBERSHIP',message:'目标20件，实际10件',at:now-1000,retryAt:now+900000,precheckMembership:{targetCount:20,actualCount:10}};
 const missing={listing:{complete:true,observedAt:now,campaigns:[]},activeComplete:true,details:new Map()};
 const result=buildCatalog({...base(),inventory:missing,checks:[check]});
 assert.equal(result.counts.recoveryFailedProducts,1);assert.equal(result.counts.pendingProducts,0);
 assert.equal(result.products[0].recoveryFailure.retryAt,check.retryAt);
 assert.equal(result.products[0].recoveryFailure.detail.actualCount,10);
 assert.equal(buildCatalog({...base(),checks:[check]}).counts.recoveryFailedProducts,0);
 assert.equal(buildCatalog({...base(),inventory:missing,checks:[{...check,shopId:'another'}]}).counts.recoveryFailedProducts,0);
});
test('current SKU prices and historical prices remain distinct, including computed price provenance',()=>{
 const result=buildCatalog(base()),p=result.products[0];
 assert.equal(result.counts.observedCurrentProducts,1);assert.equal(p.state,'active');
 assert.equal(p.current[0].skus[0].saleFen,5000);assert.equal(p.history.skus[0].saleFen,6000);assert.equal(p.current[0].skus[0].saleSource,'computed-from-verified-base-and-discount');
 assert.equal(p.observedAt,now-1000);assert.equal(result.stale,false);
});
test('a historical receipt does not masquerade as a current active discount',()=>{
 const result=buildCatalog({...base(),inventory:{listing:{complete:true,observedAt:now,campaigns:[]},activeComplete:true,details:new Map()},tasks:[{shopId,phase:'verified',plans:[{productId:'300001'}],receipt:{campaignId:'400001'}}]});
 assert.equal(result.counts.observedCurrentProducts,0);assert.equal(result.products[0].state,'missing');assert.equal(result.products[0].current.length,0);
});
test('incomplete, missing, stale, and cross-shop observations cannot prove a missing discount',()=>{
 const incomplete=buildCatalog({...base(),inventory:{listing:{complete:true,observedAt:now,campaigns:[campaign]},activeComplete:false,details:new Map()}});
 assert.equal(incomplete.products[0].state,'unconfirmed');assert.equal(incomplete.counts.missingProducts,0);
 assert.equal(buildCatalog({...base(),inventory:null}).products[0].state,'unconfirmed');
 const old=buildCatalog({...base(),now:now+10*60000});assert.equal(old.stale,true);assert.equal(old.products[0].state,'unconfirmed');
 const other=buildCatalog({...base(),histories:[{...baseline,shopId:'900002',productId:'300002'}],observation:{shopId:'900002'}});assert.equal(other.products.some(p=>p.productId==='300002'),false);
});
test('removed, ambiguous and future campaign members are not counted as currently effective',()=>{
 for(const [member,status,expected] of [[{removalConfirmed:true},'进行中','missing'],[{removalAmbiguous:true},'进行中','unconfirmed'],[{},'未开始','scheduled']]){
  const inv={...inventory,listing:{...inventory.listing,campaigns:[{...campaign,status}]},details:new Map([[campaign.id,{complete:true,observedAt:now,products:[{productId:'300001',name:'商品',skus:[sku],...member}]}]])};
  const r=buildCatalog({...base(),inventory:inv});assert.equal(r.counts.observedCurrentProducts,0);assert.equal(r.products[0].state,expected);
 }
});
test('pending submissions and explicit exclusions are visible without triggering any writes',()=>{
 const r=buildCatalog({...base(),tasks:[{id:'task',shopId,phase:'unknown',plans:[{productId:'300001'}],reason:'结果未确定'}],excluded:['300001','300099']});
 assert.equal(r.products[0].pending,true);assert.equal(r.products[0].excluded,true);assert.equal(r.products.find(p=>p.productId==='300099').state,'excluded');
});
test('multiple active campaigns retain separate SKU facts and never silently choose the lowest price',()=>{
 const second={...campaign,id:'400003',name:'另一活动'};
 const r=buildCatalog({...base(),inventory:{...inventory,listing:{...inventory.listing,campaigns:[campaign,second]},details:new Map([...inventory.details,[second.id,{complete:true,observedAt:now,products:[{productId:'300001',name:'商品',skus:[{...sku,discount:40,saleFen:4000}]}]}]])}});
 assert.equal(r.products[0].current.length,2);assert.deepEqual(r.products[0].current.map(c=>c.skus[0].saleFen),[5000,4000]);assert.equal(r.counts.observedCurrentProducts,1);
});

test('a freshly read active product is visible while unrelated activity details are still loading',()=>{
 const unread={...campaign,id:'400099'};
 const r=buildCatalog({...base(),inventory:{...inventory,activeComplete:false,listing:{...inventory.listing,campaigns:[campaign,unread]}}});
 assert.equal(r.complete,false);assert.equal(r.products[0].state,'active');assert.equal(r.counts.observedCurrentProducts,1);
 const absent=buildCatalog({...base(),histories:[baseline,{...baseline,productId:'300099'}],inventory:{...inventory,activeComplete:false}});
 assert.equal(absent.products.find(p=>p.productId==='300099').state,'unconfirmed');assert.equal(absent.counts.missingProducts,0);
});

test('one old detail does not hide another freshly observed product or prove an absent product',()=>{
 const second={...campaign,id:'400003'};
 const r=buildCatalog({...base(),histories:[baseline,{...baseline,productId:'300099'}],inventory:{...inventory,listing:{...inventory.listing,campaigns:[campaign,second]},details:new Map([...inventory.details,[second.id,{complete:true,observedAt:now-6*60000,products:[{productId:'300002',name:'旧读取',skus:[sku]}]}]])}});
 assert.equal(r.stale,true);assert.equal(r.products.find(p=>p.productId==='300001').state,'active');assert.equal(r.products.find(p=>p.productId==='300002').state,'unconfirmed');
 assert.equal(r.products.find(p=>p.productId==='300099').state,'unconfirmed');assert.equal(r.counts.observedCurrentProducts,1);assert.equal(r.counts.missingProducts,0);
});

test('a stale activity listing cannot claim a fresh current status from detail rows alone',()=>{
 const r=buildCatalog({...base(),inventory:{...inventory,listing:{...inventory.listing,observedAt:now-6*60000}}});
 assert.equal(r.products[0].state,'unconfirmed');assert.equal(r.counts.observedCurrentProducts,0);
});

const recycledCheck=()=>({shopId,productId:'300001',code:'PRODUCT_RECYCLED',at:now,message:'商品已在平台回收站',productState:{source:'live-platform-product-recycle',kind:'recycled',shopId,productId:'300001',observedAt:now,complete:true}});
test('a live recycle observation is displayed separately from a missing discount',()=>{
 const r=buildCatalog({...base(),inventory:null,checks:[recycledCheck()]});
 assert.equal(r.products[0].state,'recycled');assert.equal(r.counts.missingProducts,0);assert.equal(r.counts.recycledProducts,1);assert.equal(r.products[0].history.skus.length,1);
});
test('stale and cross-shop recycle checks cannot claim a current recycled state',()=>{
 const stale=buildCatalog({...base(),inventory:null,checks:[recycledCheck()],now:now+6*60000});
 assert.equal(stale.products[0].state,'unconfirmed');assert.equal(stale.counts.recycledProducts,0);
 const cross=buildCatalog({...base(),inventory:null,checks:[{...recycledCheck(),shopId:'900002'}]});assert.equal(cross.products[0].check,undefined);
});
test('recycle checks cannot hide current activity or an unknown submit',()=>{
 assert.equal(buildCatalog({...base(),checks:[recycledCheck()]}).products[0].state,'active');
 const r=buildCatalog({...base(),inventory:null,checks:[recycledCheck()],tasks:[{shopId,phase:'unknown',plans:[{productId:'300001'}]}]});
 assert.equal(r.products[0].state,'pending');assert.equal(r.products[0].pending,true);
});

test('a new scan retains separately labeled last-read prices without proving current activity or loss',()=>{
 const previous=catalogObservation(shopId,inventory),unread={listing:{...inventory.listing,observedAt:now+1000},activeComplete:false,details:new Map()};
 const saved=catalogObservation(shopId,unread,previous),r=buildCatalog({...base(),inventory:unread,observation:saved,now:now+1000}),p=r.products[0];
 assert.equal(p.current.length,0);assert.equal(p.state,'unconfirmed');assert.equal(r.counts.observedCurrentProducts,0);assert.equal(r.counts.missingProducts,0);
 assert.equal(p.lastObserved[0].skus[0].saleFen,5000);assert.equal(p.lastObserved[0].observedAt,now-1000);assert.equal(p.history.skus[0].saleFen,6000);
 const restarted=buildCatalog({...base(),inventory:null,observation:saved,now:now+1000});assert.equal(restarted.products[0].state,'unconfirmed');assert.equal(restarted.products[0].lastObserved.length,1);
});
test('last-read display cannot cross stores, changed campaigns or override a new removal observation',()=>{
 const previous=catalogObservation(shopId,inventory),unread={listing:{...inventory.listing,observedAt:now+1000},activeComplete:false,details:new Map()};
 const other=catalogObservation(shopId,unread,{...previous,shopId:'900002'});assert.equal(buildCatalog({...base(),inventory:unread,observation:other}).products[0].lastObserved.length,0);
 const changed={...unread,listing:{...unread.listing,campaigns:[{...campaign,risk:true}]}};
 assert.equal(buildCatalog({...base(),inventory:changed,observation:catalogObservation(shopId,changed,previous)}).products[0].lastObserved.length,0);
 const removed={...inventory,details:new Map([[campaign.id,{complete:true,observedAt:now,products:[{productId:'300001',name:'商品',removalConfirmed:true,skus:[sku]}]}]])};
 const r=buildCatalog({...base(),inventory:removed,observation:catalogObservation(shopId,removed,previous)});assert.equal(r.products[0].lastObserved.length,0);assert.equal(r.products[0].state,'missing');
});

test('last-read prices cannot override pending submissions, exclusions or fresh recycle observations',()=>{
 const unread={listing:{...inventory.listing,observedAt:now+1000},activeComplete:false,details:new Map()};
 const observation=catalogObservation(shopId,unread,catalogObservation(shopId,inventory));
 const params={...base(),inventory:unread,observation,now:now+1000};
 for(const [extra,state] of [[{tasks:[{shopId,phase:'unknown',plans:[{productId:'300001'}]}]},'pending'],[{excluded:['300001']},'excluded'],[{checks:[recycledCheck()]},'recycled']]){
  const result=buildCatalog({...params,...extra}),p=result.products[0];
  assert.equal(p.state,state);assert.equal(p.current.length,0);assert.equal(p.lastObserved.length,1);assert.equal(result.counts.observedCurrentProducts,0);assert.equal(result.counts.missingProducts,0);
 }
});

for(const code of ['RESTORE_SKU_BUDGET','RESTORE_PRODUCT_BUDGET'])test('program capacity failure is visible without claiming current loss or platform price rejection: '+code,()=>{
 const capacity={source:'program-execution-budget',productCount:code==='RESTORE_PRODUCT_BUDGET'?51:1,skuCount:501,maxProducts:50,maxSkus:500};
 const check={shopId,productId:'300001',code,message:'本次501个当前规格超过程序每批500个规格的执行容量',at:now,retryAt:now+900000,restoreCapacity:capacity};
 const r=buildCatalog({...base(),inventory:null,checks:[check]}),p=r.products[0];
 assert.equal(r.counts.recoveryFailedProducts,1);assert.equal(p.recoveryFailure.stage,'planning');assert.equal(p.recoveryFailure.code,code);
 assert.deepEqual(p.recoveryFailure.capacity,capacity);assert.equal(p.recoveryFailure.detail,null);assert.equal(p.state,'unconfirmed');
 assert.match(p.recoveryFailure.submission,/尚未进入恢复任务入队和提交/);assert.equal(p.history.skus.length,1);
});

for(const mode of ['active','unknown','excluded'])test('an older capacity check cannot override a current '+mode+' state',()=>{
 const check={shopId,productId:'300001',code:'RESTORE_SKU_BUDGET',message:'程序容量不足',at:now,retryAt:now+900000};
 const args={...base(),checks:[check],...(mode==='active'?{}:{inventory:null}),...(mode==='unknown'?{tasks:[{shopId,phase:'unknown',plans:[{productId:'300001'}]}]}:{}),...(mode==='excluded'?{excluded:['300001']}:{})};
 const r=buildCatalog(args);assert.equal(r.counts.recoveryFailedProducts,0);assert.equal(r.products[0].recoveryFailure,undefined);
 assert.equal(r.products[0].state,mode==='unknown'?'pending':mode);
});
