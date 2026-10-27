import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';
import {currentReadOperation} from '../src/read-operations.mjs';

for(const method of ['precheck','precheckBatch'])test(`${method} owns its read pages, cancels a hung renderer and rejects late results`,async()=>{
 let closed=false,finish,published=false;
 const raw={isClosed:()=>closed,close:async()=>{closed=true;},evaluate:()=>new Promise(r=>{finish=r;})};
 class HungPlatform extends DoudianPlatform{
  async precheck(){return this.hung();}
  async precheckBatch(){return this.hung();}
  async hung(){
   const op=currentReadOperation();assert.ok(op,'precheck must run inside the tracked read operation');
   const page=op.page(raw);await page.evaluate(()=>null);published=true;return{complete:true};
  }
 }
 const p=new HungPlatform({browser:{failure:async()=>{}},policy:{shopId:'900001'}});
 p.readOperations.stepMs=20;p.readOperations.cleanupMs=30;p.readOperations.pollMs=0;
 await assert.rejects(()=>p[method]([]),{code:'READ_OPERATION_TIMEOUT'});
 assert.equal(closed,true);assert.equal(p.readHealth().active.length,0);assert.equal(p.readHealth().quarantined,false);
 finish({complete:true});await new Promise(r=>setTimeout(r,5));assert.equal(published,false);
 assert.equal(p.readHealth().last.kind,method==='precheck'?'precheck':'batch-precheck');
});
