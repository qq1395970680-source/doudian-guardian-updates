import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Journal} from '../src/journal.mjs';
import {DoudianPlatform,PLATFORM,LIST} from '../src/platform.mjs';
import {planOriginalRestore,proveDraft} from '../src/policy.mjs';
import {makePriceReviews} from '../src/price-review.mjs';
import {interruptedUpgradeJournal} from '../desktop/interrupted-upgrade-journal.mjs';
import {priceFixture} from './helpers/price-review-fixture.mjs';
import {AccountRegistry} from '../src/accounts.mjs';
import {setDualActivityCarePolicy} from '../src/dual-activity-recovery.mjs';
import {lastInactiveProductEvidence} from '../src/catalog-visibility.mjs';

// All native controls below are local stubs. Exercise the real platform click
// ordering, real durable Journal transactions and independent readOnly SQLite;
// never open a browser or a production database.
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'guardian-upgrade-boundary-')),path=join(directory,'guardian.sqlite');
 let journal=new Journal(path);t.after(()=>{journal.close();rmSync(directory,{recursive:true,force:true});});
 const now=Date.now(),shopId='900001',productId='300001';
 const baseline={source:'verified-platform-history',complete:true,shopId,productId,campaignId:'400001',type:'限时抢购',
  rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},skus:[{id:'500001',name:'规格甲',baseFen:10000,discount:60}]};
 const policy={shopId,originalRiskAllowed:true,allowMissingHistoricalSkus:true};
 const plan=planOriginalRestore(baseline,{shopId,productId,complete:true,observedAt:now,skus:baseline.skus},policy,now);
 journal.remember(baseline,now);const task=journal.enqueue(shopId,[plan],{complete:true,observedAt:now,lossKey:'upgrade-boundary'},now);
 const observation={kind:'draft',shopId,title:task.title,type:plan.type,rules:plan.rules,complete:true,observedAt:now,
  startAt:now,endAt:now+48*3600000,rows:plan.skus.map(s=>({...s,productId})),warnings:[],dialogs:[]};
 const read=()=>{const db=new DatabaseSync(path,{readOnly:true});try{const row=db.prepare('SELECT phase,body FROM tasks WHERE id=?').get(task.id);return{phase:row.phase,...JSON.parse(row.body)};}finally{db.close();}};
 return{now,task,observation,read,runtime:directory,get journal(){return journal;},restart(){journal.close();journal=new Journal(path);journal.recoverInterrupted(shopId,Date.now());return journal.get(task.id);}};
}
const cutoff=()=>Object.assign(Error('simulated process termination at native boundary'),{code:'SIMULATED_EXIT'});
function nativeControl(onClick){
 const control={count:async()=>1,filter:()=>control,click:async options=>{if(!options?.trial)await onClick();}};return control;
}
function mainFacade(f,control){return{check(){},assertWrite(){},identity:async()=>{},observeDraft:async()=>f.observation,
 page:{getByRole:()=>control}};}
function riskFacade(f,control){
 const dialogs={filter:()=>dialogs,count:async()=>1,locator:()=>({evaluateAll:async()=>[]}),getByRole:()=>control};
 const observation={...f.observation,dialogs:['1个商品存在低价风险，请谨慎新建 预估最低到手价 ID：300001 仍要创建']};
 const page={url:()=>PLATFORM+LIST+'/create',evaluate:async()=>({login:false,names:['隔离测试店'],ids:[f.task.shopId]}),getByRole:()=>dialogs};
 return{base:PLATFORM,check(){},assertWrite(){},probe:async()=>({name:'隔离测试店',shopId:f.task.shopId}),observeDraft:async()=>observation,page};
}
function prepare(f){f.journal.transition(f.task.id,'queued','prepared',{},f.now);}
function submitRecorded(f){prepare(f);f.journal.beginSubmit(f.task.id,proveDraft(f.task,f.observation,f.now),f.now);}

test('main native submit sees a committed full boundary before click; interruption remains readback-only',async t=>{
 const f=fixture(t);prepare(f);let nativeClicks=0;
 const control=nativeControl(()=>{nativeClicks++;const persisted=f.read();assert.equal(persisted.phase,'submitting');assert.equal(persisted.submitAttempts,1);assert.equal(persisted.riskAttempts,0);assert.equal(persisted.draftProof.taskId,f.task.id);throw cutoff();});
 const platform=mainFacade(f,control);
 await assert.rejects(DoudianPlatform.prototype.submit.call(platform,f.task,{page:platform.page,observation:f.observation},()=>assert.fail('no risk continuation'),proof=>f.journal.beginSubmit(f.task.id,proof)),{code:'SIMULATED_EXIT'});
 assert.equal(nativeClicks,1);const before=f.read(),after=f.restart();assert.equal(after.phase,'unknown');
 for(const field of ['plans','submitAttempts','riskAttempts','submittedAt','draftProof'])assert.deepEqual(after[field],before[field]);
 assert.throws(()=>f.journal.beginSubmit(f.task.id,proveDraft(f.task,f.observation,f.now),f.now),{code:'SUBMIT_PROOF'});
 assert.throws(()=>f.journal.transition(f.task.id,'unknown','queued'),{code:'JOURNAL_TRANSITION'});
});

test('native risk confirmation sees a committed risk boundary before click; interruption cannot repeat it',async t=>{
 const f=fixture(t);submitRecorded(f);let nativeClicks=0;
 const control=nativeControl(()=>{nativeClicks++;const persisted=f.read();assert.equal(persisted.phase,'submitting');assert.equal(persisted.submitAttempts,1);assert.equal(persisted.riskAttempts,1);assert.equal(persisted.riskProof.taskId,f.task.id);throw cutoff();});
 const platform=riskFacade(f,control);let recordedProof;
 await assert.rejects(DoudianPlatform.prototype.confirmOriginalRisk.call(platform,f.journal.get(f.task.id),platform.page,proof=>{recordedProof=proof;f.journal.beginRiskConfirmation(f.task.id,proof);}),{code:'SIMULATED_EXIT'});
 assert.equal(nativeClicks,1);const before=f.read(),after=f.restart();assert.equal(after.phase,'unknown');
 for(const field of ['plans','submitAttempts','riskAttempts','submittedAt','riskAttemptedAt','draftProof','riskProof'])assert.deepEqual(after[field],before[field]);
 assert.throws(()=>f.journal.beginRiskConfirmation(f.task.id,recordedProof),{code:'RISK_PROOF'});
});

test('failed durable main boundary prevents every real native submit click',async t=>{
 const f=fixture(t);prepare(f);let nativeClicks=0;const platform=mainFacade(f,nativeControl(()=>{nativeClicks++;}));
 await assert.rejects(DoudianPlatform.prototype.submit.call(platform,f.task,{page:platform.page,observation:f.observation},()=>{},()=>{throw cutoff();}),{code:'SIMULATED_EXIT'});
 assert.equal(nativeClicks,0);assert.equal(f.read().submitAttempts,0);const after=f.restart();assert.equal(after.phase,'blocked');assert.equal(after.submitAttempts,0);assert.equal(after.riskAttempts,0);assert.ok(after.retryAfter>0);
});

test('failed durable risk boundary prevents every real native risk click',async t=>{
 const f=fixture(t);submitRecorded(f);let nativeClicks=0;const platform=riskFacade(f,nativeControl(()=>{nativeClicks++;}));
 await assert.rejects(DoudianPlatform.prototype.confirmOriginalRisk.call(platform,f.journal.get(f.task.id),platform.page,()=>{throw cutoff();}),{code:'SIMULATED_EXIT'});
 assert.equal(nativeClicks,0);assert.equal(f.read().riskAttempts,0);const after=f.restart();assert.equal(after.phase,'unknown');assert.equal(after.submitAttempts,1);assert.equal(after.riskAttempts,0);
});

test('a new process cannot reconstruct the discarded risk page or click from unknown diagnostics',async t=>{
 const f=fixture(t);submitRecorded(f);const after=f.restart(),before=f.read();let attempted=0;
 const resumed=await DoudianPlatform.prototype.resumeOriginalRisk.call({drafts:new Map(),confirmOriginalRisk:async()=>{attempted++;throw Error('must not reconstruct the old native page');}},after,()=>assert.fail('must not claim a risk attempt'));
 assert.equal(resumed,false);assert.equal(attempted,0);assert.deepEqual(f.read(),before);
});

test('offline normalization preserves nonempty approved targets, full history, retained inactive proof and actual dual grant byte-for-byte',async t=>{
 const f=fixture(t),j=f.journal,prices=priceFixture(j,f.now);
 const review=j.recordPriceReview(makePriceReviews(prices.task,prices.probe,f.now)[0],f.now);
 j.transition(prices.task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED',retryAfter:f.now+900000},f.now);
 j.decidePriceReview(review.shopId,review.id,review.key,'approve',{acceptPriceAndRisk:true,confirmedSkuIds:review.rows.map(row=>row.id),historicalFingerprint:review.historicalFingerprint},f.now+1);
 const accounts=new AccountRegistry(j);accounts.register({shopId:f.task.shopId},'signin-upgrade-grant');accounts.authorizeOriginal(f.task.shopId);
 setDualActivityCarePolicy(j,f.task.shopId,{enabled:true,acceptBothActivityTypes:true,acceptNonReducingRecovery:true},f.now+2);
 j.putProductCheck(f.task.shopId,f.task.plans[0].productId,{code:'OFF_SHELF',at:f.now,productState:{source:'live-platform-product-management',kind:'off-shelf',status:'已下架',
  shopId:f.task.shopId,productId:f.task.plans[0].productId,observedAt:f.now,complete:true}});
 j.putProductCheck(f.task.shopId,f.task.plans[0].productId,{code:'LOAD_TIMEOUT',at:f.now+1});
 assert.ok(lastInactiveProductEvidence({shopId:f.task.shopId,productId:f.task.plans[0].productId,check:j.productChecks(f.task.shopId)[0],now:f.now+2}));
 const tables=['price_reviews','price_targets','baselines','product_checks','settings'];
 const snapshot=()=>Object.fromEntries(tables.map(table=>[table,j.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const before=snapshot();for(const table of tables)assert.ok(before[table].length>0,table+' has a real preservation sample');
 const expected={pid:123456789,processIds:[123456789,123456788],instance:'isolated-upgrade',sourceBuild:'a'.repeat(64),startedAt:f.now-1000,
  shopId:f.task.shopId,url:'http://127.0.0.1:19001',sourceRoot:join(f.runtime,'versions','old'),runtime:f.runtime};
 const deps={isAlive:()=>false,probe:async()=>({state:'absent'}),now:()=>f.now+10};
 const checkpoint=await interruptedUpgradeJournal({runtime:f.runtime,expected,mode:'interrupt-checkpoint'},deps);
 const proof=await interruptedUpgradeJournal({runtime:f.runtime,expected,mode:'interrupt-finalize',cutoverId:checkpoint.cutoverId},deps);
 assert.equal(proof.recordsPreserved,true);assert.deepEqual(snapshot(),before);
 assert.deepEqual(j.priceTarget(review.shopId,review.productId).rows.map(row=>row.saleFen),[6672,6000]);
 assert.equal(j.get(f.task.id).phase,'blocked');assert.equal(j.get(f.task.id).submitAttempts,0);assert.equal(j.get(f.task.id).riskAttempts,0);
});
