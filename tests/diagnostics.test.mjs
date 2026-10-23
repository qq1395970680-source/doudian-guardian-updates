import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {exportDiagnostics,redactDiagnostic} from '../src/diagnostics.mjs';
import {DedicatedBrowser} from '../src/browser.mjs';

function entries(buffer){const files={};let offset=0;while(buffer.readUInt32LE(offset)===0x04034b50){
 const size=buffer.readUInt32LE(offset+18),n=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28),start=offset+30+n+extra;
 files[buffer.subarray(offset+30,offset+30+n).toString()]=buffer.subarray(start,start+size);offset=start+size;
}return files;}

test('redaction retains safe DOM table headers while excluding credentials and HTTP headers',()=>{
 const clean=redactDiagnostic({tableHeaders:[{text:'活动限量'}],headers:{Authorization:'private'},requestHeaders:{Cookie:'private'},cookie:'private',accessToken:'private'});
 assert.deepEqual(clean,{tableHeaders:[{text:'活动限量'}]});
});

test('runtime provenance is immutable per event across restart and reports legacy errors as unattributed',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-runtime-provenance-')),path=join(runtime,'test.sqlite');let journal=new Journal(path);
 try{
  journal.event(null,'product-blocked',{shopId:'900001',code:'PRECHECK_MEMBERSHIP',message:'legacy'},10);
  assert.equal(typeof journal.setDiagnosticContext,'function');
  journal.setDiagnosticContext({version:'2.0.0-beta.31',sourceBuild:'a'.repeat(64),instance:'a'.repeat(32),startedAt:20});
  journal.event(null,'product-blocked',{shopId:'900001',code:'PRECHECK_MEMBERSHIP',message:'previous version'},30);
  journal.close();journal=new Journal(path);
  const context={version:'2.0.0-beta.32',sourceBuild:'b'.repeat(64),instance:'b'.repeat(32),startedAt:40};journal.setDiagnosticContext(context);
  journal.event(null,'product-blocked',{shopId:'900001',code:'PRECHECK_MEMBERSHIP',message:'current version',runtimeBuild:{version:'spoofed'}},50);
  journal.event(null,'control-error',{shopId:'900001',code:'STOPPED',message:'正常维护停止'},60);
  journal.event(null,'unknown',{shopId:'900001',reason:'process-restarted-readback-only'},70);
  journal.putProductCheck('900001','300001',{code:'PRECHECK_MEMBERSHIP'});
  assert.equal(journal.productChecks('900001')[0].runtimeBuild.sourceBuild,context.sourceBuild);
  const report=await exportDiagnostics({root:resolve('.'),runtime,journal,shopId:'900001',status:{...context,shopId:'900001'},catalog:{products:[]}});
  const files=entries(await readFile(report.path)),summary=JSON.parse(files['summary.json']);
  assert.equal(summary.failureSummary.currentBuild,1);assert.equal(summary.failureSummary.otherBuild,1);assert.equal(summary.failureSummary.unattributed,1);
  assert.equal(summary.failureSummary.latest.at,50);assert.equal(summary.failureSummary.latest.runtimeBuild.version,context.version);
  assert.equal(summary.failureSummary.normalMaintenance,1);assert.equal(summary.failureSummary.pendingResults,1);
  const events=JSON.parse(files['events.json']);assert.equal(events.find(e=>e.detail.message==='previous version').detail.runtimeBuild.version,'2.0.0-beta.31');assert.equal(events.find(e=>e.detail.message==='legacy').detail.runtimeBuild,undefined);
 }finally{journal.close();await rm(runtime,{recursive:true,force:true});}
});

test('a full diagnostic payload keeps summary, manifest and accurate omission notices',{timeout:30000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-full-diagnostics-')),journal=new Journal(':memory:');
 try{
  const catalog={products:[{productId:'300001',payload:'x'.repeat(49*1024*1024)}]};
  const report=await exportDiagnostics({root:resolve('.'),runtime,journal,shopId:'900001',status:{version:'test',sourceBuild:'test',shopId:'900001'},catalog});
  const files=entries(await readFile(report.path));assert.ok(files['summary.json']);assert.ok(files['manifest.json']);assert.ok(files['README.txt']);
  const summary=JSON.parse(files['summary.json']);assert.ok(summary.skipped.some(x=>x.name==='catalog.json'));
  assert.equal(report.omissions,summary.skipped.length);assert.ok(report.omissions>0);assert.ok(report.failureSummary);
 }finally{journal.close();await rm(runtime,{recursive:true,force:true});}
});

test('diagnostic ZIP is scoped, bounded, redacted, read-only and includes the running source',{timeout:30000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-diagnostics-')),journal=new Journal(':memory:');
 try{
  journal.event(null,'product-blocked',{shopId:'900001',productId:'300001',code:'PRECHECK_MEMBERSHIP',token:'secret-token',message:'Cookie: secret-cookie',precheckMembership:{targetProductIds:['300001'],actualProductIds:[],snapshot:{counts:[1]}}});
  journal.event(null,'product-blocked',{shopId:'900002',message:'other-shop-private'});
  await mkdir(join(runtime,'evidence','300001-batch'),{recursive:true});
  await writeFile(join(runtime,'evidence','300001-batch','precheck.json'),JSON.stringify({code:'PRECHECK_MEMBERSHIP',observation:{shopId:'900001',counts:[1]}}));
  await writeFile(join(runtime,'evidence','300001-batch','precheck.png'),Buffer.from('fixture-image'));
  await writeFile(join(runtime,'guardian.sqlite'),'must-not-export-database');await mkdir(join(runtime,'profiles'));await writeFile(join(runtime,'profiles','Cookies'),'must-not-export-cookies');
  const count=journal.events().length;
  const result=await exportDiagnostics({root:resolve('.'),runtime,journal,shopId:'900001',status:{version:'test',sourceBuild:'test',shopId:'900001',running:true,accounts:[{shopId:'900002',name:'other-shop-name'}]},catalog:{products:[{productId:'300001'}]},includeScreenshots:true});
  const bytes=await readFile(result.path),text=bytes.toString();
  assert.ok(bytes.readUInt32LE(0)===0x04034b50);assert.match(text,/PRECHECK_MEMBERSHIP/);assert.match(text,/source\/src\/platform.mjs/);assert.match(text,/precheck.png/);
  for(const forbidden of ['secret-token','secret-cookie','other-shop-private','other-shop-name','must-not-export-database','must-not-export-cookies'])assert.ok(!text.includes(forbidden),forbidden);
  assert.equal(journal.events().length,count);assert.equal(journal.list('900001').length,0);assert.equal(result.shopId,'900001');
 }finally{journal.close();await rm(runtime,{recursive:true,force:true});}
});

test('failure capture keeps recent occurrences and never pairs an error with a stale screenshot',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-failure-history-')),browser=new DedicatedBrowser(runtime,{test:true});
 browser.diagnosticContext={version:'2.0.0-beta.32',sourceBuild:'c'.repeat(64),instance:'d'.repeat(32),startedAt:1};
 try{
  for(let i=0;i<7;i++){await browser.failure({screenshot:async()=>Buffer.from('screenshot-'+i)},'300001-batch','precheck',{code:'PRECHECK_MEMBERSHIP',message:'failure '+i},{shopId:'900001',token:'private-secret'});await new Promise(r=>setTimeout(r,3));}
  const folder=join(runtime,'evidence','300001-batch'),files=await readdir(folder);assert.equal(files.filter(f=>/^precheck-\d+\.json$/.test(f)).length,5);
  assert.ok(!(await readFile(join(folder,'precheck.json'),'utf8')).includes('private-secret'));
  assert.deepEqual(JSON.parse(await readFile(join(folder,'precheck.json'),'utf8')).runtimeBuild,browser.diagnosticContext);
  await browser.failure({screenshot:async()=>{throw Error('closed');}},'300001-batch','precheck',{code:'PRECHECK_MEMBERSHIP',message:'new error'},{shopId:'900001'});
  assert.ok(!(await readdir(folder)).includes('precheck.png'));
 }finally{await rm(runtime,{recursive:true,force:true});}
});
