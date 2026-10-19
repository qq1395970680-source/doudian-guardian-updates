import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';
import {GuardianService} from '../src/service.mjs';
import {makePriceReviews} from '../src/price-review.mjs';
import {priceFixture} from './helpers/price-review-fixture.mjs';

test('selected shop has an explicit price review queue; reading it never grants price permission',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-price-api-')),journal=new Journal(':memory:');
 const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),stop(){}};
 const app=await createApp({config:{shopId:'900001'},runtime,port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform:{progress:{stage:'test'}}}});
 try{const r=await fetch(app.url+'/api/price-reviews');assert.equal(r.status,200);const body=await r.json();assert.equal(body.shopId,'900001');assert.deepEqual(body.reviews,[]);assert.equal(app.snapshot().originalRestoreAuthorized,false);}
 finally{await app.close();await rm(runtime,{recursive:true,force:true});}
});

for(const mode of ['correct','no-connection','wrong-shop','external-origin','no-token','missing-sku','no-consent','changed-history','excluded','pending-task','client-price'])test('price review API validates explicit human choice: '+mode,async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-price-api-')),journal=new Journal(':memory:'),now=Date.now(),f=priceFixture(journal,now);
 const review=journal.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);journal.transition(f.task.id,'queued','blocked',{},now);
 const platform={progress:{stage:'test'},probe:async()=>({shopId:f.policy.shopId,name:'API测试'})};
 const service=new GuardianService({journal,platform,policy:f.policy});
 const app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform}});
 try{
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1];
  const headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
  if(mode!=='no-connection'){
   assert.equal((await fetch(app.url+'/api/finish-login',{method:'POST',headers,body:'{}'})).status,202);
   for(let i=0;i<50&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.snapshot().connection?.shopId,f.policy.shopId);
  }
  const args={shopId:review.shopId,reviewId:review.id,key:review.key,decision:'approve',confirmedSkuIds:review.rows.map(r=>r.id),acceptPriceAndRisk:true};
  if(mode==='wrong-shop')args.shopId='900002';if(mode==='external-origin')headers.Origin='https://example.com';if(mode==='no-token')delete headers['X-Guardian-Token'];
  if(mode==='missing-sku')args.confirmedSkuIds.pop();if(mode==='no-consent')args.acceptPriceAndRisk=false;
  if(mode==='changed-history'){journal.remember({...f.baseline,campaignId:'4000000000000000099',historyAt:now+100},now+100);}
  if(mode==='excluded')f.policy.excludedProductIds.push(review.productId);
  if(mode==='pending-task')journal.enqueue(review.shopId,[f.plan],{complete:true,lossKey:'unresolved',observedAt:now},now);
  if(mode==='client-price')args.rows=review.rows.map(r=>({...r,discount:10,saleFen:1390}));
  // A different product may be scanning. Recording this consent must not
  // execute any platform action inside the HTTP request.
  service.busy=true;
  const r=await fetch(app.url+'/api/price-reviews/decide',{method:'POST',headers,body:JSON.stringify(args)}),body=await r.json();
  const accepted=['correct','client-price'].includes(mode);assert.equal(r.status,accepted?200:400,JSON.stringify(body));
  const target=journal.priceTarget(review.shopId,review.productId);
  if(accepted){assert.equal(target.status,'approved');assert.equal(target.rows[0].discount,48);assert.equal(journal.get(f.task.id).submitAttempts,0);assert.equal(journal.get(f.task.id).phase,'blocked');}
  else assert.equal(target,null);
 }finally{service.busy=false;await app.close();await rm(runtime,{recursive:true,force:true});}
});
