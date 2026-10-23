import {readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {zip} from './workbook.mjs';
import {requireThat} from './policy.mjs';

// Diagnostic files are output only. No execution/planning path imports them.
export function redactDiagnostic(value){
 if(Array.isArray(value))return value.map(redactDiagnostic);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k==='tableHeaders'||!/(?:cookie|token|authorization|password|secret|storageState|profileKey|headers|environment)/i.test(k)).map(([k,v])=>[k,redactDiagnostic(v)]));
 if(typeof value==='string')return value.replace(/\u001b\[[0-9;]*m/g,'').replace(/(?:Bearer\s+)[\w.+/=-]+/gi,'Bearer [REDACTED]')
  .replace(/\b(cookie|authorization|token|password|secret)\s*[:=]\s*[^\r\n]+/gi,'$1: [REDACTED]')
  .replace(/https?:\/\/[^\s"<>]+/g,s=>{try{const u=new URL(s);u.username='';u.password='';u.search='';u.hash='';return u.toString();}catch{return '[URL]';}});
 return value;
}
export async function exportDiagnostics({root,runtime,journal,shopId,status,catalog,includeScreenshots=false}){
 requireThat(shopId&&/^\d{3,25}$/.test(shopId),'ACCOUNT_UNKNOWN','请先选择需要诊断的店铺');
 const at=Date.now(),files={},skipped=[],maxBytes=48*1024*1024,metadataReserve=2*1024*1024;let bytes=0;
 const add=(name,data)=>{const b=Buffer.isBuffer(data)?data:Buffer.from(data),metadata=['summary.json','manifest.json','README.txt'].includes(name);
  if(bytes+b.length>maxBytes-(metadata?0:metadataReserve)){skipped.push({name,reason:'archive-size-limit'});return false;}files[name]=b;bytes+=b.length;return true;};
 const json=(name,value)=>add(name,JSON.stringify(redactDiagnostic(value),null,2)+'\n');
 const safeRead=async(base,path,max=8*1024*1024)=>{
  const target=resolve(base,path),rel=relative(resolve(base),target);requireThat(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'DIAGNOSTIC_PATH','诊断路径越界');
  let cursor=resolve(base);requireThat(!(await lstat(cursor)).isSymbolicLink(),'DIAGNOSTIC_PATH','诊断目录不能是链接');
  for(const part of rel.split(/[\\/]/)){cursor=join(cursor,part);const s=await lstat(cursor);requireThat(!s.isSymbolicLink(),'DIAGNOSTIC_PATH','诊断不读取目录链接');}
  const s=await lstat(target);requireThat(s.isFile()&&s.size<=max,'DIAGNOSTIC_SIZE','诊断文件过大或不是普通文件');return readFile(target);
 };
 const tasks=journal.list(shopId),checks=journal.productChecks(shopId);
 const rows=journal.db.prepare("SELECT seq,task,at,kind,body FROM events WHERE json_extract(body,'$.shopId')=? OR task IN (SELECT id FROM tasks WHERE shop=?) ORDER BY seq DESC LIMIT 2001").all(shopId,shopId);
 let events=rows.slice(0,2000).map(({body,...r})=>({...r,detail:JSON.parse(body)}));
 while(events.length>1&&Buffer.byteLength(JSON.stringify(events))>8*1024*1024)events=events.slice(0,Math.ceil(events.length/2));
 const statusFields=['version','sourceBuild','build','startedAt','shopId','name','running','busy','nextAt','patrolStartedAt','lastRun','lastSuccessfulRun','lastPriorityCheck','progress','readHealth','unknown','verified','blocked','action','lastAction','loginOpen','originalRestoreAuthorized','automaticPriceIncreaseEnabled','priceReviewsPending'];
 json('status.json',Object.fromEntries(statusFields.filter(k=>Object.hasOwn(status,k)).map(k=>[k,status[k]])));
 json('events.json',events);json('product-checks.json',checks);json('tasks.json',tasks);json('catalog.json',catalog);
 json('price-reviews.json',journal.priceReviews(shopId));
 const ids=new Set([...(catalog?.products||[]).map(p=>p.productId),...checks.map(c=>c.productId),...events.map(e=>e.detail?.productId)].filter(Boolean));
 const campaignIds=new Set([...(catalog?.campaignIds||[]),...(catalog?.products||[]).flatMap(p=>[p.campaignId,...(p.campaigns||[]).map(c=>c.id)]),...events.map(e=>e.detail?.campaignId)].filter(v=>/^\d+$/.test(v)));
 const folders=new Set([...tasks.map(t=>t.id),...[...ids].flatMap(id=>[id,id+'-batch']),'inventory',...campaignIds]);
 let evidenceFiles=0;const evidence=[];
 for(const folder of folders){if(!/^[a-zA-Z0-9-]+$/.test(folder))continue;
  const base=join(runtime,'evidence',folder);
  try{if((await lstat(base)).isSymbolicLink())continue;
   for(const name of await readdir(base))if(/^(precheck|prepare|submit|list|detail|renewal|identity|close-monitors)(?:-\d+)?\.json$/.test(name)){
    const path=join('evidence',folder,name),data=JSON.parse((await safeRead(runtime,path)).toString('utf8'));
    const owner=data.observation?.shopId;
    // Older evidence lacks a shop marker; only a persisted task can prove its
    // shop. Product IDs alone cannot establish which logged-in shop was read.
    if(owner!==shopId&&!(owner==null&&tasks.some(t=>t.id===folder))){skipped.push({name:path,reason:'shop-not-proven'});continue;}
    evidence.push({path,data,at:data.at||0});
   }
  }catch(e){if(e.code!=='ENOENT')skipped.push({name:folder,reason:e.code||'unreadable'});}
 }
 evidence.sort((a,b)=>b.at-a.at);
 for(const item of evidence.slice(0,60)){
  if(json(item.path.replaceAll('\\','/'),item.data))evidenceFiles++;
  if(includeScreenshots&&!/LOGIN|ACCOUNT|SHOP_MISMATCH/.test(item.data.code||'')){
   const path=item.path.replace(/\.json$/,'.png');try{if(add(path.replaceAll('\\','/'),await safeRead(runtime,path)))evidenceFiles++;}catch(e){skipped.push({name:path,reason:e.code||'unreadable'});}
  }
 }
 if(evidence.length>60)skipped.push({name:'evidence',reason:'latest-60-records-only'});
 // Explicit source allowlist; never recurse through the runtime or profiles.
 for(const directory of ['src','public','desktop'])for(const name of await readdir(join(root,directory))){
  if(!/\.(mjs|cjs|js|html|css)$/.test(name))continue;
  try{add('source/'+directory+'/'+name,await safeRead(root,join(directory,name),2*1024*1024));}catch(e){skipped.push({name:directory+'/'+name,reason:e.code||'unreadable'});}
 }
 for(const name of ['package.json','package-lock.json'])add('source/'+name,await safeRead(root,name,2*1024*1024));
 const maintenance=e=>e.detail?.code==='STOPPED'||/^STOPPED(?::|$)/.test(e.detail?.reason||'')||e.detail?.reason==='pre-submit-proof-expired-on-restart';
 const failures=events.filter(e=>!maintenance(e)&&['product-blocked','control-error','readback-error','verification-pending','blocked','read-operation-failed'].includes(e.kind));
 const recorded=e=>e.detail?.runtimeBuild;
 const validBuild=e=>/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(recorded(e)?.version)&&/^[a-f0-9]{64}$/.test(recorded(e)?.sourceBuild);
 const latest=failures.reduce((a,b)=>!a||b.at>a.at?b:a,null);
 const failureSummary={events:failures.length,normalMaintenance:events.filter(maintenance).length,pendingResults:events.filter(e=>e.kind==='unknown'&&!maintenance(e)).length,
  currentBuild:failures.filter(e=>validBuild(e)&&recorded(e).sourceBuild===status.sourceBuild).length,
  otherBuild:failures.filter(e=>validBuild(e)&&recorded(e).sourceBuild!==status.sourceBuild).length,unattributed:failures.filter(e=>!validBuild(e)).length,
  latest:latest?{at:latest.at,kind:latest.kind,code:latest.detail?.code||null,runtimeBuild:validBuild(latest)?recorded(latest):null}:null,
  scope:'exported event window only; absent build information is not assigned to the current version'};
 const summary={schema:1,diagnosticOnly:true,notRecoveryInput:true,at,shopId,version:status.version,sourceBuild:status.sourceBuild,
  events:events.length,eventsTruncated:rows.length>events.length,eventCursor:events[0]?.seq||null,taskCount:tasks.length,productCheckCount:checks.length,
  precheckFailures:events.filter(e=>e.detail?.code==='PRECHECK_MEMBERSHIP').length,failureSummary,evidenceFiles,includeScreenshots,skipped,
  snapshotConsistency:'Read-only snapshot taken while service may be running; files retain their individual timestamps. Historical errors are not current loss proof.',
  excluded:['browser profiles','cookies','credentials','complete database','environment','arbitrary local files','other shops']};
 json('summary.json',summary);
 add('README.txt','折扣守护诊断包（仅供排查，禁止作为恢复、价格批准或执行输入）\n包含当前店铺商品ID、价格、运行事件、源码及选择附带的故障截图。请仅发送给可信排查人员。\nsummary.json 列明截断、缺失及跳过原因。旧版本未保存的信息无法补造；缺少证据不代表正常。\n导出不会停止守护或提交活动。错误现场和当前概览可能属于不同时间。\n');
 json('manifest.json',Object.entries(files).map(([path,b])=>({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')})));
 const name=`DoudianGuardian-Diagnostics-${shopId}-${new Date(at).toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.zip`;
 const directory=join(runtime,'diagnostics');await mkdir(directory,{recursive:true});requireThat(!(await lstat(directory)).isSymbolicLink(),'DIAGNOSTIC_PATH','诊断输出目录不能是链接');
 const path=join(directory,name),archive=zip(files);await writeFile(path,archive,{flag:'wx'});
 return{ok:true,name,path,shopId,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),events:events.length,evidenceFiles,skipped:skipped.length,omissions:skipped.length,failureSummary};
}
