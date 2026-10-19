import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.mjs';
import {PriorityWatch} from '../src/priority-watch.mjs';
const c={id:'400001',status:'进行中'},listing=campaigns=>({complete:true,campaigns,observedAt:Date.now()});
const detail=products=>({complete:true,observedAt:Date.now(),products:products.map(p=>typeof p==='string'?{productId:p}:p)});

test('priority index records no prices and detects missing campaigns or explicit member removal',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe(c,detail(['300001','300002']));assert.deepEqual(w.hints(listing([c])),[]);
  assert.equal(w.hints(listing([])).length,2);
  w.observe(c,detail([{productId:'300001',removalConfirmed:true},'300002']));assert.deepEqual(w.hints(listing([c])).map(x=>x.productId),['300001']);
  assert.doesNotMatch(JSON.stringify(j.settings(w.key)),/baseFen|discount|saleFen|authorized/);
 }finally{j.close();}
});

test('another independently observed current campaign suppresses an old missing hint',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe(c,detail(['300001']));const replacement={id:'400002',status:'进行中'};w.observe(replacement,detail(['300001']));
  assert.deepEqual(w.hints(listing([replacement])),[]);
 }finally{j.close();}
});

test('display diagnostics cannot seed monitoring and shop indexes stay isolated across restart',()=>{
 const j=new Journal(':memory:');try{
  j.putSettings('catalog-view:900001',{listing:listing([c]),details:[[c.id,detail(['300001'])]]});
  assert.deepEqual(new PriorityWatch(j,'900001').hints(listing([])),[]);
  const w=new PriorityWatch(j,'900001');w.observe(c,detail(['300001']));
  assert.equal(new PriorityWatch(j,'900001').hints(listing([])).length,1);assert.deepEqual(new PriorityWatch(j,'900002').hints(listing([])),[]);
 }finally{j.close();}
});

test('an incomplete list cannot generate missing hints and an ambiguous member is never a positive observation',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe(c,detail([{productId:'300001',removalAmbiguous:true}]));
  assert.throws(()=>w.hints({...listing([]),complete:false}),{code:'ACTIVE_UNKNOWN'});assert.equal(w.hints(listing([c])).length,1);
 }finally{j.close();}
});

test('a disappearing detail row remains a hint across restart and is cleared by a fresh positive detail',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe(c,detail(['300001','300002']));
  w.observe(c,detail(['300002']));assert.deepEqual(w.hints(listing([c])).map(x=>x.productId),['300001']);
  const restarted=new PriorityWatch(j,'900001');assert.deepEqual(restarted.hints(listing([c])).map(x=>x.productId),['300001']);
  restarted.observe(c,detail(['300001','300002']));assert.deepEqual(restarted.hints(listing([c])),[]);
 }finally{j.close();}
});

test('a newly risk-marked active campaign is prioritized for reading, never treated as a missing product',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe({...c,risk:false},detail(['300001','300002']));
  const changed=listing([{...c,risk:true}]);
  assert.deepEqual(w.priorityCampaignIds(changed),[c.id]);
  assert.deepEqual(w.hints(changed),[],'risk alone cannot establish which product lost its discount');
  assert.deepEqual(new PriorityWatch(j,'900001').priorityCampaignIds(changed),[c.id]);
  w.observe({...c,risk:true},detail(['300001',{productId:'300002',removalConfirmed:true}]));
  assert.deepEqual(w.priorityCampaignIds(changed),[]);
  assert.deepEqual(w.hints(changed).map(p=>p.productId),['300002']);
  w.recordOne('300001',c.id,Date.now()+1);w.save();
  assert.deepEqual(new PriorityWatch(j,'900001').priorityCampaignIds(changed),[],'a receipt must preserve the risk flag already read');
 }finally{j.close();}
});

test('risk reading priority requires a complete listing, respects shop isolation and ignores ended campaigns',()=>{
 const j=new Journal(':memory:');try{
  const w=new PriorityWatch(j,'900001');w.observe({...c,risk:true},detail(['300001']));
  assert.deepEqual(new PriorityWatch(j,'900002').priorityCampaignIds(listing([{...c,risk:true}])),[c.id]);
  assert.deepEqual(w.priorityCampaignIds(listing([{...c,status:'已失效',risk:true}])),[]);
  assert.throws(()=>w.priorityCampaignIds({...listing([{...c,risk:true}]),complete:false}),{code:'ACTIVE_UNKNOWN'});
  w.observe({...c,risk:false},detail(['300001']));
  assert.deepEqual(w.priorityCampaignIds(listing([{...c,risk:true}])),[c.id],'a new risk transition must be read again');
 }finally{j.close();}
});
