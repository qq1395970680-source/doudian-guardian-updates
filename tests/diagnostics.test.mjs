import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Journal} from '../src/journal.mjs';
import {exportDiagnostics} from '../src/diagnostics.mjs';
import {DedicatedBrowser} from '../src/browser.mjs';

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
 try{
  for(let i=0;i<7;i++){await browser.failure({screenshot:async()=>Buffer.from('screenshot-'+i)},'300001-batch','precheck',{code:'PRECHECK_MEMBERSHIP',message:'failure '+i},{shopId:'900001',token:'private-secret'});await new Promise(r=>setTimeout(r,3));}
  const folder=join(runtime,'evidence','300001-batch'),files=await readdir(folder);assert.equal(files.filter(f=>/^precheck-\d+\.json$/.test(f)).length,5);
  assert.ok(!(await readFile(join(folder,'precheck.json'),'utf8')).includes('private-secret'));
  await browser.failure({screenshot:async()=>{throw Error('closed');}},'300001-batch','precheck',{code:'PRECHECK_MEMBERSHIP',message:'new error'},{shopId:'900001'});
  assert.ok(!(await readdir(folder)).includes('precheck.png'));
 }finally{await rm(runtime,{recursive:true,force:true});}
});
