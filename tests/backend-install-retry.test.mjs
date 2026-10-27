import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,cp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareBackend,validateBundle} from '../desktop/backend.mjs';

async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'guardian-install-retry-')),bundleRoot=join(dir,'bundle'),runtime=join(dir,'runtime'),manifest=[];
 try{
  for(const path of ['engine/node.exe','src/server.mjs','config/default.json']){
   const bytes=Buffer.from('inactive fixture '+path);await mkdir(dirname(join(bundleRoot,path)),{recursive:true});await writeFile(join(bundleRoot,path),bytes);
   manifest.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await writeFile(join(bundleRoot,'manifest-sha256.json'),JSON.stringify(manifest));await mkdir(runtime);await writeFile(join(runtime,'guardian.sqlite'),'task-and-price-records-preserved');
  const bundleId=await validateBundle(bundleRoot);await mkdir(join(runtime,'versions'));
  await run({bundleRoot,runtime,bundleId,target:join(runtime,'versions',bundleId)});
  assert.equal(await readFile(join(runtime,'guardian.sqlite'),'utf8'),'task-and-price-records-preserved');
 }finally{await rm(dir,{recursive:true,force:true});}
}
const denied=()=>Object.assign(Error('Windows sharing violation'),{code:'EPERM'});
test('a transient Windows rename denial retries the same validated staging folder without recopying or touching tasks',()=>fixture(async f=>{
 let attempts=0;const sources=[];
 const result=await prepareBackend({...f,renameDirectory:async(from,to)=>{attempts++;sources.push(from);if(attempts===1)throw denied();return rename(from,to);},sleep:async()=>{}});
 assert.equal(attempts,2);assert.equal(new Set(sources).size,1);assert.equal(result,f.target);assert.equal(await validateBundle(result),f.bundleId);
}));
test('an incomplete pre-existing target is reported before copying over it',()=>fixture(async f=>{
 await mkdir(f.target);await writeFile(join(f.target,'preserve.txt'),'keep');
 await assert.rejects(()=>prepareBackend(f),{code:'BACKEND_TARGET_INVALID'});
 assert.equal(await readFile(join(f.target,'preserve.txt'),'utf8'),'keep');assert.deepEqual(await readdir(join(f.runtime,'versions')),[f.bundleId]);
}));
test('an identical complete target created by another preparer is reused after a rename race',()=>fixture(async f=>{
 let attempts=0;const result=await prepareBackend({...f,renameDirectory:async(from,to)=>{attempts++;await cp(from,to,{recursive:true});throw denied();},sleep:async()=>{}});
 assert.equal(attempts,1);assert.equal(result,f.target);assert.equal(await validateBundle(result),f.bundleId);
}));
test('persistent Windows rename denial stops after bounded retries and retains the complete unexecuted stage',()=>fixture(async f=>{
 let attempts=0;
 await assert.rejects(()=>prepareBackend({...f,renameDirectory:async()=>{attempts++;throw denied();},sleep:async()=>{}}),e=>e.code==='EPERM'&&/完整的新版本临时目录已保留/.test(e.message));
 assert.equal(attempts,7);const names=await readdir(join(f.runtime,'versions'));assert.equal(names.length,1);assert.match(names[0],/\.install-/);
 assert.equal(await validateBundle(join(f.runtime,'versions',names[0])),f.bundleId);
}));
