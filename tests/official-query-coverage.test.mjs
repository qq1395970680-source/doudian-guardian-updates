import test from 'node:test';
import assert from 'node:assert/strict';
import {officialQueryCoverage} from '../src/official-query-coverage.mjs';
import {submissionQueryScope} from '../src/submission-investigation.mjs';
import {fingerprint} from '../src/policy.mjs';

const now=Date.parse('2026-11-04T09:00:00+08:00'),shopId='900001';
// The labels, placeholders, separate overview wording and date interval are
// from the 2026-11-04 read-only live capture. The explicit query boundary below
// is a contract fixture, not a claim that the older capture contained it.
function listing(query={productId:null,title:'守护2-fixture-submission',status:null},campaigns=[]){
 const querySurface={source:'rendered-official-query-surface',pathname:'/ffa/marketing/tools/limitsales',complete:true,
  queryRegion:{source:'minimal-common-query-ancestor',tag:'form',containsStatistics:false,queryButtonCount:1,resetButtonCount:1,titleInputCount:1,productInputCount:1,visibleInputCount:5,
   fields:[{type:'text',placeholder:'请输入活动名称',value:query.title||'',checked:null,recognized:true},{type:'text',placeholder:'请输入商品ID',value:query.productId||'',checked:null,recognized:true}],
   selects:[{label:'活动状态',kind:'ecom',selected:query.status||'全部',placeholder:'',empty:false,disabled:false},{label:'优惠类型',kind:'ecom',selected:'',placeholder:'请选择',empty:true,disabled:false},{label:'活动类型',kind:'ecom',selected:'',placeholder:'请选择',empty:true,disabled:false}],tabs:[],selectedExtras:[],dateControls:[]},
  statisticsDates:[{source:'separate-order-statistics-region',context:'数据概览 以下数据仅统计生效单品直降的商品订单数据',range:['2026/10/28','2026/11/03'],separateFromQuery:true}]};
 const before={source:'rendered-list-query-controls',observedAt:now,pathname:'/ffa/marketing/tools/limitsales',productIds:[query.productId||''],titles:[query.title||''],selections:[query.status||'全部'],dateControls:[],selectedFilters:[],selectedTabs:[],querySurface};
 const after=structuredClone(before);
 return{complete:true,shopId,observedAt:now,query,campaigns,queryScope:submissionQueryScope({shopId,query,before,after,pages:1})};
}
function fixture(){
 const target=listing(),reference=listing({productId:'300001',title:null,status:null},[
  {id:'400001',name:'历史活动甲',type:'限时抢购',status:'已结束',startAt:Date.parse('2026-10-03T01:17:27+08:00'),endAt:Date.parse('2026-10-07T01:17:27+08:00')}]);
 return{target,reference,read:()=>officialQueryCoverage(target,{referenceListings:[reference],now})};
}
const both=(l,fn)=>{fn(l.queryScope.before.querySurface);fn(l.queryScope.after.querySurface);};

test('an empty exact-title result needs a complete same-shop DOM surface and outside-statistics historical witness',()=>{
 const f=fixture(),before=fingerprint(f),r=f.read();assert.equal(r.complete,true);assert.equal(r.allDates,true);assert.deepEqual(r.activityTypes,['限时抢购','限量抢购']);
 assert.equal(r.listingFingerprint,fingerprint(f.target));assert.equal(r.evidence.rangeWitness.campaignId,'400001');assert.match(r.evidenceFingerprint,/^[a-f0-9]{64}$/);assert.equal(fingerprint(f),before);
});
test('a complete product query may corroborate its own older historical rows',()=>{
 const f=fixture(),r=officialQueryCoverage(f.reference,{now});assert.equal(r.complete,true);assert.equal(r.evidence.rangeWitness.listingFingerprint,fingerprint(f.reference));
});
test('explicit empty date endpoints count only inside the positively bounded activity-query region',()=>{
 const f=fixture();both(f.target,s=>s.queryRegion.dateControls=[{placeholder:'开始日期',value:'',region:'activity-list-query'},{placeholder:'结束日期',value:'',region:'activity-list-query'}]);
 const r=officialQueryCoverage(f.target,{now});assert.equal(r.complete,true);assert.equal(r.evidence.rangeWitness,null);
 both(f.target,s=>s.queryRegion.dateControls[0].region='order-statistics');assert.equal(f.read().complete,false);
});
test('legacy real capture with blank type placeholders and statistics dates does not fabricate new boundary evidence',()=>{
 const f=fixture();delete f.target.queryScope.before.querySurface;delete f.target.queryScope.after.querySurface;
 f.target.queryScope.before.dateControls=f.target.queryScope.after.dateControls=[{placeholder:'开始日期',value:''},{placeholder:'结束日期',value:''}];
 const r=f.read();assert.equal(r.complete,false);assert.equal(r.allDates,undefined);assert.equal(r.activityTypes,undefined);
});
for(const fault of ['missing-boundary','whole-page-boundary','missing-query-button','missing-product','unknown-input','missing-type','specific-type','unrecognized-empty','disabled-type','extra-type-select','selected-checkbox','selected-tab','date-restricted','statistics-not-separated','statistics-bad-context','statistics-invalid-date'])test('coverage refuses incomplete or restricted semantic surface: '+fault,()=>{
 const f=fixture();both(f.target,s=>{
  if(fault==='missing-boundary')s.complete=false;
  if(fault==='whole-page-boundary')s.queryRegion.containsStatistics=true;
  if(fault==='missing-query-button')s.queryRegion.queryButtonCount=0;
  if(fault==='missing-product')s.queryRegion.fields=s.queryRegion.fields.filter(x=>x.placeholder!=='请输入商品ID');
  if(fault==='unknown-input')s.queryRegion.fields.push({placeholder:'创建人',recognized:false,value:null});
  if(fault==='missing-type')s.queryRegion.selects=s.queryRegion.selects.filter(x=>x.label!=='活动类型');
  if(fault==='specific-type')Object.assign(s.queryRegion.selects[1],{selected:'限时抢购',empty:false,placeholder:''});
  if(fault==='unrecognized-empty')s.queryRegion.selects[1].placeholder='';
  if(fault==='disabled-type')s.queryRegion.selects[1].disabled=true;
  if(fault==='extra-type-select')s.queryRegion.selects.push({label:'创建人',selected:'全部',empty:false});
  if(fault==='selected-checkbox')s.queryRegion.selectedExtras=[{type:'checkbox',label:'仅我的活动'}];
  if(fault==='selected-tab')s.queryRegion.tabs=[{label:'我创建的',selected:true}];
  if(fault==='date-restricted')s.queryRegion.dateControls=[{placeholder:'开始日期',value:'2026/11/01',region:'activity-list-query'},{placeholder:'结束日期',value:'2026/11/04',region:'activity-list-query'}];
  if(fault==='statistics-not-separated')s.statisticsDates[0].separateFromQuery=false;
  if(fault==='statistics-bad-context')s.statisticsDates[0].context='活动查询日期';
  if(fault==='statistics-invalid-date')s.statisticsDates[0].range=['2026/02/30','2026/11/03'];
 });assert.equal(f.read().complete,false,fault);
});
test('before/after narrowing cannot be hidden behind a caller-supplied verified flag',()=>{
 const f=fixture();f.target.queryScope.after.querySurface.queryRegion.selects[1].selected='限量抢购';assert.equal(f.read().code,'QUERY_SURFACE_CHANGED');
});
for(const fault of ['wrong-shop','stale','different-surface','no-historical-row','row-within-statistics','incomplete-reference'])test('coverage refuses invalid cross-query corroboration: '+fault,()=>{
 const f=fixture();
 if(fault==='wrong-shop')f.reference.shopId='999999999';
 if(fault==='stale')f.reference.observedAt=now-120001;
 if(fault==='different-surface')both(f.reference,s=>s.queryRegion.tag='section');
 if(fault==='no-historical-row')f.reference.campaigns=[];
 if(fault==='row-within-statistics')Object.assign(f.reference.campaigns[0],{startAt:Date.parse('2026-10-29T00:00:00+08:00'),endAt:Date.parse('2026-10-31T00:00:00+08:00')});
 if(fault==='incomplete-reference')f.reference.complete=false;
 assert.equal(f.read().complete,false,fault);
});
test('official coverage requires fresh verified list identity and never trusts bare allDates booleans',()=>{
 const f=fixture();f.target.queryScope.allDates=true;f.target.queryScope.activityTypes=['限时抢购','限量抢购'];f.target.observedAt=now-120001;assert.equal(f.read().complete,false);
 f.target.observedAt=now;f.target.queryScope.verified=false;assert.equal(f.read().complete,false);
 assert.equal(officialQueryCoverage(null,{now}).complete,false);assert.equal(officialQueryCoverage({complete:true,allDates:true},{now}).complete,false);
});
test('a fresh final query may use only an explicitly bounded historical coverage witness without refreshing its timestamp',()=>{
 const f=fixture();f.reference.observedAt=now-137960;const before=fingerprint(f.reference);
 assert.equal(f.read().complete,false);
 assert.equal(officialQueryCoverage(f.target,{referenceListings:[f.reference],now,referenceMaxAgeMs:600000,minObservedAt:now-144567}).complete,true);
 assert.equal(fingerprint(f.reference),before);assert.equal(f.reference.observedAt,now-137960);
 assert.equal(officialQueryCoverage(f.target,{referenceListings:[f.reference],now,referenceMaxAgeMs:600001}).complete,false);
 assert.equal(officialQueryCoverage(f.target,{referenceListings:[f.reference],now,referenceMaxAgeMs:600000,minObservedAt:now-100000}).complete,false);
 f.target.observedAt=now-120001;assert.equal(officialQueryCoverage(f.target,{referenceListings:[f.reference],now,referenceMaxAgeMs:600000}).complete,false,'historical witness tolerance never ages the current target query');
});
