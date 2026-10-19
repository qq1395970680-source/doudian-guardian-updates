import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Journal} from '../src/journal.mjs';
import {makeTransfer} from '../src/migration.mjs';
import {priceFixture} from './helpers/price-review-fixture.mjs';

test('two isolated computers require matching live identity and explicit preview consent; imports never start execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-migration-api-')),source=new Journal(':memory:'),target=new Journal(':memory:');
 const f=priceFixture(source,Date.now()),file=makeTransfer(source,{...f.policy,name:'迁移测试店',excludedProductIds:['3000000000000000099']},{version:'2.0.0-beta.6'});
 let starts=0;const service={running:false,busy:false,status:()=>({unknown:0,tasks:[]}),start(){starts++;},stop(){}};
 const app=await createApp({config:{shopId:f.policy.shopId},runtime:root,port:0,dependencies:{journal:target,service,browser:{close:async()=>{}},platform:{probe:async()=>({shopId:f.policy.shopId,name:'迁移测试店'}),progress:{}}}});
 try{
  const token=(await(await fetch(app.url)).text()).match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
  const post=async(path,body,overrides={})=>{const r=await fetch(app.url+'/api/'+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  assert.equal((await post('migration/preview',{shopId:f.policy.shopId,file})).status,400);
  await post('finish-login',{});for(let i=0;i<50&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await post('migration/preview',{shopId:'900002',file})).status,400);
  assert.equal((await post('migration/preview',{shopId:f.policy.shopId,file},{Origin:'https://example.com'})).status,400);
  const preview=await post('migration/preview',{shopId:f.policy.shopId,file});assert.equal(preview.status,200);assert.equal(preview.body.products[0].skus.length,2);assert.equal(target.histories(f.policy.shopId).length,0);
  const args={shopId:f.policy.shopId,previewId:preview.body.previewId,digest:preview.body.digest,accepted:true};
  assert.equal((await post('migration/import',{...args,accepted:false})).status,400);assert.equal((await post('migration/import',{...args,digest:'changed'})).status,400);
  service.running=true;assert.equal((await post('migration/import',args)).status,400);assert.equal((await post('migration/export',{shopId:f.policy.shopId})).status,400);service.running=false;
  assert.equal((await post('migration/import',args)).status,200);assert.equal(target.histories(f.policy.shopId).length,1);assert.equal(starts,0);
  assert.equal(app.snapshot().originalRestoreAuthorized,false);assert.deepEqual(app.snapshot().excluded,['3000000000000000099']);
  assert.equal((await post('migration/import',args)).status,400,'preview can only be confirmed once');
  const exported=await post('migration/export',{shopId:f.policy.shopId});assert.equal(exported.status,200);assert.equal(exported.body.file.payload.histories.length,1);assert.equal(exported.body.file.payload.tasks.length,1);
 }finally{await app.close();source.close();await rm(root,{recursive:true,force:true});}
});
