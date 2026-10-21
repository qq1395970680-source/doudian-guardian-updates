import {randomUUID} from 'node:crypto';
import {fingerprint,id,normalizeName,requireThat,saleFen,validateHistorical,isLimited,validateLimited} from './policy.mjs';

export const TRANSFER_FORMAT='doudian-guardian-transfer';
export const TRANSFER_MAX_BYTES=32*1024*1024;
const phases=['queued','prepared','submitting','verifying','unknown','verified','blocked'];
const unresolved=t=>['submitting','verifying','unknown'].includes(t.phase);
function tables(j){j.db.exec(`CREATE TABLE IF NOT EXISTS migration_imports(digest TEXT PRIMARY KEY,shop TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_task_archive(shop TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(shop,id));`);}
function archivalPlan(plan){const {originalRiskAllowed,approvedRiskAllowed,priceApprovalId,priceApprovalKey,fingerprint:planHash,...record}=plan;return record;}
function taskMaterial(t){return {title:t.title,plans:t.plans.map(p=>({shopId:p.shopId,productId:p.productId,historicalFingerprint:p.historicalFingerprint,type:p.type,rules:p.rules,
 ...(p.durationMs!=null?{durationMs:p.durationMs}:{}),...(isLimited(p)?{activityLimit:p.activityLimit}:{}),
 skus:p.skus.map(s=>({id:s.id,name:normalizeName(s.name),baseFen:s.baseFen,discount:s.discount,saleFen:s.saleFen}))}))};}
function taskRecord(t){return {id:t.id,title:t.title,phase:t.phase,plans:t.plans.map(archivalPlan),createdAt:t.createdAt,updatedAt:t.updatedAt,
 submitAttempts:t.submitAttempts,riskAttempts:t.riskAttempts,receipt:t.receipt||null,reason:t.reason||null};}

// Export only business records owned by this application. No account registry,
// browser profile, token, settings, diagnostic snapshot or price approval moves.
export function makeTransfer(journal,account,{version,now=Date.now()}={}){
 const shopId=id(account.shopId);tables(journal);
 return journal.transaction(()=>{
  const tasks=new Map(journal.db.prepare('SELECT body FROM migration_task_archive WHERE shop=?').all(shopId).map(r=>{const t=JSON.parse(r.body);return[t.id,t];}));
  for(const t of journal.list(shopId))tasks.set(t.id,taskRecord(t));
  const histories=journal.db.prepare('SELECT at,body FROM baselines WHERE shop=? ORDER BY at DESC').all(shopId).map(r=>({at:r.at,body:JSON.parse(r.body)}));
  const payload={schema:1,exportId:randomUUID(),createdAt:now,version,shopId,name:account.name||'店铺',histories,
   excludedProductIds:[...new Set(account.excludedProductIds||[])],tasks:[...tasks.values()]};
  const file={format:TRANSFER_FORMAT,payload,digest:fingerprint(payload)};validateTransfer(file,shopId,now);return file;
 });
}

export function validateTransfer(file,expectedShop,now=Date.now()){
 requireThat(file?.format===TRANSFER_FORMAT&&Object.keys(file).sort().join(',')==='digest,format,payload','TRANSFER_FORMAT','请选择本程序导出的迁移备份，诊断文件不能导入');
 const p=file.payload;
 requireThat(p&&Object.keys(p).sort().join(',')==='createdAt,excludedProductIds,exportId,histories,name,schema,shopId,tasks,version'&&p.schema===1,
  'TRANSFER_FORMAT','迁移备份的格式或版本不受支持');
 requireThat(Buffer.byteLength(JSON.stringify(file),'utf8')<=TRANSFER_MAX_BYTES,'TRANSFER_SIZE','迁移备份超过允许大小');
 requireThat(typeof file.digest==='string'&&file.digest===fingerprint(p),'TRANSFER_CHANGED','迁移备份校验不一致，未导入任何记录');
 requireThat(id(p.shopId)===expectedShop,'SHOP_MISMATCH','备份与当前登录的店铺不一致');
 requireThat(typeof p.exportId==='string'&&/^[0-9a-f-]{36}$/.test(p.exportId)&&Number.isSafeInteger(p.createdAt)&&p.createdAt>0&&p.createdAt<=now+5000,
  'TRANSFER_TIME','备份编号或生成时间无效');
 requireThat(typeof p.name==='string'&&p.name.length<=200&&typeof p.version==='string'&&p.version.length<=80,'TRANSFER_FORMAT','备份的店铺或版本文字无效');
 requireThat(Array.isArray(p.histories)&&p.histories.length<=50000&&Array.isArray(p.tasks)&&p.tasks.length<=20000&&Array.isArray(p.excludedProductIds)&&p.excludedProductIds.length<=50000,
  'TRANSFER_SIZE','备份记录数量无效');
 const histories=new Map(),stable=new Set(),products=new Map();
 for(const row of p.histories){
  requireThat(Number.isSafeInteger(row.at)&&row.at>0&&row.at<=now+5000,'TRANSFER_TIME','历史记录时间无效');
  const b=validateHistorical(row.body);requireThat(b.shopId===p.shopId,'SHOP_MISMATCH','备份混入其他店铺的历史');
  const {observedAt,...stableBody}=b,key=fingerprint(stableBody);requireThat(!stable.has(key),'TRANSFER_DUPLICATE','备份包含重复历史');stable.add(key);histories.set(fingerprint(b),b);
  const previous=products.get(b.productId);
  if(!previous||Number(!!previous.generatedByGuardian)>Number(!!b.generatedByGuardian)||!!previous.generatedByGuardian===!!b.generatedByGuardian&&(b.historyAt||0)>(previous.historyAt||0))products.set(b.productId,b);
 }
 requireThat(new Set(p.excludedProductIds.map(v=>id(v))).size===p.excludedProductIds.length,'TRANSFER_DUPLICATE','排除商品重复');
 const taskIds=new Set();
 for(const t of p.tasks){
  requireThat(typeof t.id==='string'&&/^[0-9a-f-]{36}$/.test(t.id)&&!taskIds.has(t.id)&&typeof t.title==='string'&&/^守护2-(?:[0-9a-f]{18}|(?:[1-9](?:\.\d)?折|多折扣)-[0-9a-f]{12})$/.test(t.title)&&phases.includes(t.phase),
   'TRANSFER_TASK','任务记录格式无效或重复');taskIds.add(t.id);
  requireThat(Number.isSafeInteger(t.createdAt)&&t.createdAt>0&&Number.isSafeInteger(t.updatedAt)&&t.updatedAt>=t.createdAt&&t.updatedAt<=now+5000,
   'TRANSFER_TIME','任务记录时间无效');
  requireThat([0,1].includes(t.submitAttempts)&&[0,1].includes(t.riskAttempts)&&(!unresolved(t)||t.submitAttempts===1)&&Array.isArray(t.plans)&&t.plans.length>0&&t.plans.length<=50,
   'TRANSFER_TASK','任务提交边界无效');
  const members=new Set();
  for(const plan of t.plans){
   const b=histories.get(plan.historicalFingerprint);
   // These are archival facts, not transferred rule/price consent. Imported
   // unknown tasks can only be read back, with all confirmation counts locked.
   const converted=isLimited(plan)&&/^[a-f0-9]{64}$/.test(plan.campaignPolicyFingerprint||'');
   if(isLimited(plan)){validateLimited(plan);validateHistorical({...plan,source:'verified-platform-history',complete:true});}
   requireThat(b&&plan.shopId===p.shopId&&plan.productId===b.productId&&!members.has(plan.productId)&&
    (plan.type===b.type&&fingerprint(plan.rules)===fingerprint(b.rules)||converted),
    'TRANSFER_TASK','任务与完整历史不匹配');members.add(plan.productId);
   requireThat(Array.isArray(plan.skus)&&plan.skus.length>0&&new Set(plan.skus.map(s=>s.id)).size===plan.skus.length,'TRANSFER_TASK','任务规格缺失或重复');
   for(const s of plan.skus){const original=b.skus.find(r=>r.id===s.id);requireThat(original&&s.baseFen===original.baseFen&&normalizeName(s.name)===normalizeName(original.name)&&s.saleFen===saleFen(s.baseFen,s.discount),
    'TRANSFER_TASK','任务规格或价格与其历史来源不匹配');}
  }
 }
 return {digest:file.digest,shopId:p.shopId,name:p.name,createdAt:p.createdAt,version:p.version,historicalCount:p.histories.length,taskCount:p.tasks.length,
  unknown:p.tasks.filter(unresolved).length,excludedProductIds:p.excludedProductIds,products:[...products.values()].map(b=>({productId:b.productId,name:b.name,skus:b.skus.map(s=>({id:s.id,name:s.name,baseFen:s.baseFen,discount:s.discount,saleFen:saleFen(s.baseFen,s.discount)}))}))};
}

// The selected file is previewed first. Only a separate explicit UI confirmation
// imports the displayed history. It does not import any lower-price approval.
export function importTransfer(journal,file,{shopId,accepted,expectedDigest},now=Date.now()){
 const preview=validateTransfer(file,shopId,now);
 requireThat(accepted===true&&expectedDigest===file.digest,'TRANSFER_CONSENT','请先核对本店全部迁移历史价格，再明确确认导入');tables(journal);
 return journal.transaction(()=>{
  const prior=journal.db.prepare('SELECT body FROM migration_imports WHERE digest=? AND shop=?').get(file.digest,shopId);if(prior)return{...JSON.parse(prior.body),alreadyImported:true};
  requireThat(!journal.list(shopId).some(t=>!['verified','blocked'].includes(t.phase)),'PENDING','当前店铺仍有未完成任务，先独立核实再导入');
  const p=file.payload;let importedHistories=0,unknown=0;
  for(const row of p.histories){journal.remember(row.body,row.at);importedHistories+=journal.db.prepare('SELECT changes() AS n').get().n;}
  for(const t of p.tasks){
   const existing=journal.get(t.id);requireThat(!existing||existing.shopId===shopId,'SHOP_MISMATCH','已有任务编号属于另一店铺');
   requireThat(!existing||fingerprint(taskMaterial(existing))===fingerprint(taskMaterial(t))&&(!unresolved(t)||existing.phase==='verified'||existing.submitAttempts===1),'TRANSFER_TASK','已有同编号任务的价格或提交状态与备份冲突');
   const archived=journal.db.prepare('SELECT body FROM migration_task_archive WHERE shop=? AND id=?').get(shopId,t.id);
   if(!archived||JSON.parse(archived.body).updatedAt<t.updatedAt)journal.db.prepare('INSERT INTO migration_task_archive VALUES(?,?,?) ON CONFLICT(shop,id) DO UPDATE SET body=excluded.body').run(shopId,t.id,JSON.stringify(t));
   if(!unresolved(t)||existing)continue;
   const body={title:t.title,plans:t.plans.map(plan=>({...plan,originalRiskAllowed:false,approvedRiskAllowed:false})),createdAt:t.createdAt,
    submitAttempts:1,riskAttempts:1,importedAt:now,reason:'从迁移备份保留的未知提交，仅独立回读；不重建草稿或重复提交'};
   journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(t.id,shopId,'migration-unknown:'+t.id,'unknown',JSON.stringify(body),now);unknown++;
  }
  const settings=journal.settings('application'),account=settings?.accounts?.find(a=>a.shopId===shopId),excludedProductIds=[...new Set([...(account?.excludedProductIds||[]),...p.excludedProductIds])];
  if(account){account.excludedProductIds=excludedProductIds;journal.putSettings('application',settings);}
  const result={shopId,importedHistories,products:preview.products.length,archivedTasks:p.tasks.length,unknown,excludedProductIds,digest:file.digest,confirmedAt:now};
  journal.db.prepare('INSERT INTO migration_imports VALUES(?,?,?,?)').run(file.digest,shopId,now,JSON.stringify(result));
  journal.event(null,'history-imported',{shopId,digest:file.digest,histories:importedHistories,unknown},now);return result;
 });
}
