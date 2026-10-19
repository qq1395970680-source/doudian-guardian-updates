import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform} from '../src/platform.mjs';
import {buildCatalog} from '../src/catalog.mjs';
const now=Date.now();
function fixture(){
 const journal=new Journal(':memory:'),platform=new DoudianPlatform({browser:{context:{}},policy:{shopId:'900001'},journal});
 const listing={complete:true,observedAt:now-6*60000,campaigns:[{id:'400001',name:'活动',type:'限时抢购',status:'进行中'}]};
 platform.inventory={listing,activeComplete:false,details:new Map([['400001',{complete:true,observedAt:now,products:[{productId:'300001',name:'已核对',skus:[{id:'600001',name:'原规格',baseFen:10000,discount:50}]}]}]])};
 return{journal,platform,listing};
}
test('a fresh matching current list keeps newly read prices visible during a long scan without refreshing old history',()=>{
 const f=fixture();try{
  assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now}),true);
  assert.equal(f.listing.observedAt,now-6*60000);
  const view=buildCatalog({shopId:'900001',inventory:f.platform.inventory,now});
  assert.equal(view.products[0].state,'active');assert.equal(view.counts.observedCurrentProducts,1);assert.equal(view.complete,false);
  assert.equal(view.listingObservedAt,now);
  const saved=f.journal.settings('catalog-view:900001');
  assert.equal(saved.listing.observedAt,now-6*60000);
  assert.equal(buildCatalog({shopId:'900001',observation:saved,now}).products[0].state,'active');
 }finally{f.journal.close();}
});
test('a changed or incomplete current list cannot redate a previous inventory',()=>{
 const f=fixture();try{
  assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now,campaigns:[]}),false);
  assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now,complete:false}),false);
  for(const field of ['name','type','status','risk','startAt','endAt'])
   assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now,campaigns:[{...f.listing.campaigns[0],[field]:'changed'}]}),false);
  assert.equal(f.listing.currentObservedAt,undefined);assert.equal(buildCatalog({shopId:'900001',inventory:f.platform.inventory,now}).products[0].state,'unconfirmed');
 }finally{f.journal.close();}
});
test('matching membership cannot refresh stale SKU observations or move its current observation backwards',()=>{
 const f=fixture();try{
  f.platform.inventory.activeComplete=true;
  f.platform.inventory.details.get('400001').observedAt=now-6*60000;
  assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now}),true);
  assert.equal(f.platform.refreshCurrentEvidence({...f.listing,observedAt:now-60000}),false);
  const view=buildCatalog({shopId:'900001',inventory:f.platform.inventory,now});
  assert.equal(view.products[0].state,'unconfirmed');assert.equal(view.stale,true);
  assert.equal(view.listingObservedAt,now);assert.equal(view.observedAt,now-6*60000);
 }finally{f.journal.close();}
});
