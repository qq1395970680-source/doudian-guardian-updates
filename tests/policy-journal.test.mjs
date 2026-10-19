import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOriginalRestore, proveReadback, proveDraft, fingerprint } from '../src/policy.mjs';
import { Journal } from '../src/journal.mjs';

const now = 1792407698000;
export function sample(productId = '3000000000000000001', shopId = '900001') {
  const baseline = { source:'verified-platform-history', complete:true, shopId, productId, name:'测试商品',
    campaignId:'4000000000000000001', type:'限时抢购', rules:{noLimit:true,noPerUserLimit:true,noWarmup:true,orderMinutes:30},
    skus:[{id:'5000000000000000001',name:'规格甲',baseFen:12300,discount:60},{id:'5000000000000000002',name:'规格乙',baseFen:45600,discount:60}] };
  return { baseline, current:{shopId,productId,observedAt:now,complete:true,skus:structuredClone(baseline.skus)},
    policy:{shopId,allowMissingHistoricalSkus:true,originalRiskAllowed:true,excludedProductIds:[]} };
}
const plan = () => { const s=sample();return planOriginalRestore(s.baseline,s.current,s.policy,now); };
test('same historical discount supports another shop without product-specific code', () => {
  const s=sample('3000000000000000099','900009');const p=planOriginalRestore(s.baseline,s.current,s.policy,now);
  assert.equal(p.shopId,'900009');assert.deepEqual(p.skus.map(x=>x.saleFen),[7380,27360]);
});
test('missing historical SKU preserves source and returns only a nonempty exact subset', () => {
  const s=sample(), before=fingerprint(s.baseline);s.current.skus.pop();const p=planOriginalRestore(s.baseline,s.current,s.policy,now);
  assert.equal(p.skus.length,1);assert.deepEqual(p.skippedSkuIds,['5000000000000000002']);assert.equal(fingerprint(s.baseline),before);
});
for(const [label,change,code] of [
  ['changed original price',s=>s.current.skus[0].baseFen++, 'BASE_PRICE_CHANGED'],
  ['new SKU',s=>s.current.skus.push({id:'5999999999999999999',name:'新规格',baseFen:10000}), 'NEW_OR_AMBIGUOUS_SKU'],
  ['duplicate current SKU',s=>s.current.skus.push(s.current.skus[0]), 'DUPLICATE_SKU'],
  ['wrong shop',s=>s.current.shopId='900002', 'SHOP_MISMATCH'],
  ['explicit exclusion',s=>s.policy.excludedProductIds.push(s.baseline.productId), 'EXCLUDED'],
  ['explicit off shelf',s=>s.current.offShelf=true, 'OFF_SHELF'],
  ['existing active campaign',s=>s.current.activeCampaign='4000000000000000002', 'ALREADY_ACTIVE'],
  ['incomplete virtual list',s=>s.current.complete=false, 'STALE_OR_INCOMPLETE'],
  ['expired probe',s=>s.current.observedAt=now-120001, 'STALE_OR_INCOMPLETE'],
  ['diagnostic cannot be a baseline',s=>s.baseline.source='extension-local-export', 'UNVERIFIED_HISTORY'],
  ['missing subset without authorization',s=>{s.current.skus.pop();s.policy.allowMissingHistoricalSkus=false;}, 'MISSING_SKUS'],
  ['unknown previous submit',s=>s.baseline.pending={at:now}, 'PENDING']
]) test(label,()=>{const s=sample();change(s);assert.throws(()=>planOriginalRestore(s.baseline,s.current,s.policy,now),{code});});
test('independent readback checks every SKU and exact sale price',()=>{
  const p=plan(),o={shopId:p.shopId,title:'task',campaignId:'4000000000000000002',observedAt:now,complete:true,status:'进行中',type:p.type,rules:p.rules,
    rows:p.skus.map(s=>({...s,productId:p.productId}))};
  assert.equal(proveReadback([p],o,{title:'task',now}).skuCount,2);
  o.rows[1].saleFen--;assert.throws(()=>proveReadback([p],o,{title:'task',now}),{code:'READBACK_PRICE'});
});
function taskIn(j) { const p=plan();return j.enqueue(p.shopId,[p],{complete:true,lossKey:'original-ended-4000000000000000001',observedAt:now},now); }
function proof(t){return proveDraft(t,{kind:'draft',title:t.title,shopId:t.shopId,complete:true,observedAt:now,type:t.plans[0].type,rules:t.plans[0].rules,
 rows:t.plans.flatMap(p=>p.skus.map(s=>({...s,productId:p.productId}))),warnings:[],dialogs:[],startAt:now,endAt:now+48*3600000},now);}
test('enqueue is idempotent and single writer lease is per shop',()=>{
  const j=new Journal(':memory:');try{
    assert.equal(taskIn(j).id,taskIn(j).id);j.lease('900001','worker-a',now);
    assert.throws(()=>j.lease('900001','worker-b',now+1),{code:'BUSY'});j.lease('900002','worker-b',now+1);
  }finally{j.close();}
});
test('persisted submit is recovered as unknown, never replayed after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'guardian-journal-')),path=join(dir,'journal.sqlite');let j=new Journal(path);
  try{
    const t=taskIn(j);j.transition(t.id,'queued','prepared',{},now);j.beginSubmit(t.id,proof(t),now);
    j.close();j=new Journal(path);j.recoverInterrupted(t.shopId);
    assert.equal(j.get(t.id).phase,'unknown');assert.equal(j.get(t.id).submitAttempts,1);
    assert.throws(()=>j.beginSubmit(t.id,{taskId:t.id,at:now},now),{code:'SUBMIT_PROOF'});
    assert.throws(()=>j.transition(t.id,'unknown','queued'),{code:'JOURNAL_TRANSITION'});
  }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});
test('risk confirmation is persisted at most once and bound to original prices',()=>{
  const j=new Journal(':memory:');try{
    const t=taskIn(j);j.transition(t.id,'queued','prepared');j.beginSubmit(t.id,proof(t),now);
    assert.throws(()=>j.beginRiskConfirmation(t.id,{taskId:t.id,samePrices:false},now),{code:'RISK_PROOF'});
    const risk={taskId:t.id,kind:'original-discount-risk',at:now,observation:{...proof(t).observation,dialogs:[`1个商品存在低价风险，请谨慎新建 预估最低到手价 ID：${t.plans[0].productId} 仍要创建`]}};
    j.beginRiskConfirmation(t.id,risk,now);
    assert.equal(j.get(t.id).riskAttempts,1);
    assert.throws(()=>j.beginRiskConfirmation(t.id,risk,now),{code:'RISK_PROOF'});
  }finally{j.close();}
});
test('full histories survive later nonempty subset work and stay separated by shop',()=>{
  const j=new Journal(':memory:');try{
    const a=sample(),b=sample('3000000000000000001','900002');j.remember(a.baseline,now);j.remember(b.baseline,now);
    a.current.skus.pop();planOriginalRestore(a.baseline,a.current,a.policy,now);
    assert.equal(j.histories('900001')[0].skus.length,2);assert.equal(j.histories('900002')[0].shopId,'900002');
  }finally{j.close();}
});
