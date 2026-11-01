import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {createApp} from '../src/server.mjs';
import {seedPriceQueue} from './helpers/large-price-queue-fixture.mjs';
import {requestRecovery} from '../src/recovery-requests.mjs';

const shopId='900001',product=i=>String(3000000000000000000n+BigInt(i));
function inactive(j,i,{recycled=false,proofPatch={},checkPatch={}}={}){
 const at=Date.now()-86400000;
 j.putProductCheck(shopId,product(i),{code:recycled?'PRODUCT_RECYCLED':'OFF_SHELF',at,message:'独立核实已下架',
  productState:{kind:recycled?'recycled':'off-shelf',source:recycled?'live-platform-product-recycle':'live-platform-product-management',
   status:'已下架',complete:true,shopId,productId:product(i),observedAt:at,...proofPatch},...checkPatch});
}
async function fixture(run,{platform={}}={}){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-hidden-inactive-')),j=new Journal(':memory:');
 seedPriceQueue(j,{pending:8,approved:4});
 for(let i=0;i<12;i++)j.db.prepare('INSERT INTO baselines VALUES(?,?,?,?,?)').run(shopId,product(i),'fixture-'+i,Date.now()-100000,
  JSON.stringify({shopId,productId:product(i),name:'测试商品 '+i,historyAt:Date.now()-100000,skus:[]}));
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId},runtime,port:0,dependencies:{journal:j,service,browser:{close:async()=>{}},platform}});
 const get=async path=>(await fetch(app.url+path)).json();
 try{await run({j,get});}finally{await app.close();await rm(runtime,{recursive:true,force:true});}
}

test('off-shelf and recycled products stay hidden in both views, counts and deep pages without deleting history',async()=>fixture(async({j,get})=>{
 for(let i=0;i<5;i++)inactive(j,i,{recycled:i===4});inactive(j,10);
 // A code without verified, matching platform evidence cannot hide a product.
 inactive(j,6,{proofPatch:{shopId:'900002'}});inactive(j,7,{proofPatch:{complete:false}});
 requestRecovery(j,shopId,[{productId:product(0)},{productId:product(11)}],'fixture');
 const before=j.db.prepare('SELECT COUNT(*) n FROM price_reviews').get().n;
 const catalog=await get('/api/products');
 assert.equal(catalog.counts.products,6);
 assert.deepEqual(catalog.products.map(p=>p.productId),[5,6,7,8,9,11].map(product));
 const status=await get('/api/status');assert.equal(status.priceReviewsPending,3);assert.equal(status.priceRechecksPending,1);
 const seen=[];
 for(let page=0;page<3;page++){
  const result=await get('/api/price-reviews?page='+page+'&size=2');
  assert.equal(result.total,6);assert.equal(result.pending,3);assert.equal(result.pages,3);assert.equal(result.reviews.length,2);
  seen.push(...result.reviews.map(r=>r.productId));
  assert.equal(result.rechecks.total,1);assert.equal(result.rechecks.records[0].productId,product(11));
  assert.ok(result.recoveryIssues.every(r=>![0,1,2,3,4,10].map(product).includes(r.productId)));
 }
 assert.equal(new Set(seen).size,6);assert.equal((await get('/api/price-reviews?direction=increase')).total,3);
 assert.equal(j.priceReviews(shopId).length,before);assert.equal(j.priceReviewCounts(shopId).pending,8);
 assert.equal(j.histories(shopId).length,12);assert.equal(j.productChecks(shopId).length,8);
 assert.equal(j.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
}));

test('fresh active activity and unresolved submissions remain visible despite an older off-shelf check',async()=>{
 const now=Date.now(),campaign={id:'400001',status:'进行中',endAt:now+600000};
 const platform={inventory:{listing:{complete:true,observedAt:now,campaigns:[campaign]},activeComplete:true,
  details:new Map([[campaign.id,{complete:true,observedAt:now,products:[{productId:product(0),name:'重新上架',skus:[]}]}]])}};
 await fixture(async({j,get})=>{
  inactive(j,0);inactive(j,1);
  j.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('unknown-task',shopId,'unknown-dedupe','unknown',JSON.stringify({id:'unknown-task',shopId,phase:'unknown',plans:[{productId:product(1)}],updatedAt:now}),now);
  const catalog=await get('/api/products');assert.equal(catalog.counts.products,12);
  assert.equal(catalog.products.find(p=>p.productId===product(0)).state,'active');
  assert.equal(catalog.products.find(p=>p.productId===product(1)).pending,true);
  assert.equal((await get('/api/price-reviews')).pending,8);
 },{platform});
});
