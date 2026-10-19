import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCatalog} from '../src/catalog.mjs';
const now=1792437600000,shopId='900001';
const sku={id:'500001',name:'PP棉',baseFen:10000,discount:50,saleFen:5000,saleSource:'computed-from-verified-base-and-discount'};
const baseline={shopId,productId:'300001',name:'历史商品',campaignId:'400001',historyAt:now-100000,skus:[{...sku,discount:60,saleFen:6000}]};
const campaign={id:'400002',name:'当前活动',status:'进行中',startAt:now-50000,endAt:now+100000};
const inventory={listing:{complete:true,observedAt:now,campaigns:[campaign]},activeComplete:true,details:new Map([[campaign.id,{complete:true,observedAt:now-1000,products:[{productId:'300001',name:'当前商品',skus:[sku]}]}]])};
const base=()=>({shopId,inventory,histories:[baseline],tasks:[],excluded:[],now});
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
