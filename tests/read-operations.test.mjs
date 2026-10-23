import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadOperations,currentReadOperation} from '../src/read-operations.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fakePage({closeHangs=false}={}){
 let closed=false;
 return {evaluate:async()=>({login:false}),isClosed:()=>closed,
  close:()=>closeHangs?new Promise(()=>{}):Promise.resolve().then(()=>{closed=true;})};
}
test('hung read is cancelled, pages close, and a late browser result cannot publish evidence',async()=>{
 const manager=new ReadOperations({budgetMs:40,stepMs:25,cleanupMs:30,pollMs:0});
 const raw=fakePage();let finish,published=false;
 const result=manager.run({kind:'detail',campaignId:'123'},async()=>{
  const op=currentReadOperation(),page=op.page(raw);
  raw.evaluate=()=>new Promise(r=>{finish=r;});await page.evaluate(()=>null);published=true;
 });
 await assert.rejects(result,{code:'READ_OPERATION_TIMEOUT'});
 assert.equal(raw.isClosed(),true);finish({complete:true});await wait(10);assert.equal(published,false);
 assert.equal(manager.snapshot().active.length,0);assert.equal(manager.quarantined,false);
});
test('unconfirmed page and context cleanup quarantines the browser instead of releasing it',async()=>{
 const manager=new ReadOperations({budgetMs:40,stepMs:25,cleanupMs:20,pollMs:0,isolate:()=>new Promise(()=>{})});
 await assert.rejects(manager.run({kind:'detail'},async()=>{
  currentReadOperation().page(fakePage({closeHangs:true}));await new Promise(()=>{});
 }),{code:'READ_CLEANUP_BLOCKED'});
 assert.equal(manager.quarantined,true);
 await assert.rejects(manager.run({kind:'list'},async()=>true),{code:'READ_CLEANUP_BLOCKED'});
});
test('login interruption on a non-login URL closes the pending read without waiting for locator timeout',async()=>{
 const manager=new ReadOperations({budgetMs:1000,stepMs:800,cleanupMs:30,pollMs:5});
 const raw=fakePage();raw.evaluate=async()=>({login:true});
 await assert.rejects(manager.run({kind:'renewal'},async()=>{
  currentReadOperation().page(raw);await new Promise(()=>{});
 }),{code:'LOGIN_REQUIRED'});
 assert.equal(raw.isClosed(),true);
});
test('stop cancels every active read and the cleanup completes before the group drains',async()=>{
 const manager=new ReadOperations({budgetMs:1000,cleanupMs:30,pollMs:0}),pages=[fakePage(),fakePage()];
 const work=pages.map((p,i)=>manager.run({kind:'detail',campaignId:String(i)},async()=>{currentReadOperation().page(p);await new Promise(()=>{});}));
 await wait(5);manager.cancel('STOPPED','停止');
 const results=await Promise.allSettled(work);assert.ok(results.every(v=>v.reason?.code==='STOPPED'));assert.ok(pages.every(p=>p.isClosed()));
 assert.equal(manager.snapshot().active.length,0);
});

test('stop during concurrent page creation shares one confirmed context close without false quarantine',async()=>{
 let closes=0;
 const manager=new ReadOperations({budgetMs:1000,stepMs:1000,cleanupMs:40,pollMs:0,isolate:async()=>{
  closes++;if(closes>1)throw Error('context already closed');await wait(10);return true;
 }});
 const work=[1,2].map(()=>manager.run({kind:'list'},async()=>currentReadOperation().newPage(()=>new Promise(()=>{}))));
 await wait(5);manager.cancel();const results=await Promise.allSettled(work);
 assert.ok(results.every(r=>r.reason?.code==='STOPPED'));assert.equal(closes,1);assert.equal(manager.quarantined,false);
});
test('a late newly created page cannot escape the cleanup page snapshot',async()=>{
 const late=fakePage(),early=fakePage();early.close=async()=>{await wait(10);};early.isClosed=()=>true;
 let creation;
 const manager=new ReadOperations({budgetMs:1000,cleanupMs:50,pollMs:0,isolate:async()=>{await late.close();return true;}});
 const work=manager.run({kind:'list'},async()=>{const op=currentReadOperation();op.page(early);await op.newPage(()=>new Promise(r=>{creation=r;}));});
 await wait(5);manager.cancel();creation(late);const result=await Promise.allSettled([work]);
 assert.equal(result[0].reason.code,'STOPPED');assert.equal(late.isClosed(),true);assert.equal(manager.quarantined,false);
});
