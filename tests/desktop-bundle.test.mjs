import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareBackend,validateBundle} from '../desktop/backend.mjs';
test('desktop stages immutable code separately from task data and refuses tampering',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'guardian-bundle-test-')),bundleRoot=join(folder,'bundle'),runtime=join(folder,'runtime'),manifest=[];
 try{
  for(const path of ['engine/node.exe','src/server.mjs','config/default.json']){
   const bytes=Buffer.from('local test fixture '+path);await mkdir(dirname(join(bundleRoot,path)),{recursive:true});await writeFile(join(bundleRoot,path),bytes);
   manifest.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await writeFile(join(bundleRoot,'manifest-sha256.json'),JSON.stringify(manifest));await mkdir(runtime);await writeFile(join(runtime,'guardian.sqlite'),'preserved-task-data');
  const first=await prepareBackend({bundleRoot,runtime});assert.equal(await prepareBackend({bundleRoot,runtime}),first);
  assert.equal(await readFile(join(runtime,'guardian.sqlite'),'utf8'),'preserved-task-data');
  await writeFile(join(first,'src/server.mjs'),'tampered');await assert.rejects(prepareBackend({bundleRoot,runtime}),/校验失败/);
  manifest[0].path='../outside';await writeFile(join(bundleRoot,'manifest-sha256.json'),JSON.stringify(manifest));await assert.rejects(validateBundle(bundleRoot),/路径无效/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
