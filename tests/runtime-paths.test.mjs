import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeDirectory} from '../desktop/runtime-directory.mjs';
import {projectBuild} from '../src/build.mjs';

test('desktop persists canonical owned runtime across redirected host and native Explorer launches',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-physical-'));try{
  const parent=join(dir,'实际路径'),alias=join(dir,'alias'),install=join(dir,'install');await mkdir(parent);await mkdir(install);await symlink(parent,alias,'junction');
  const runtime=runtimeDirectory({fallback:join(alias,'DoudianDiscountGuardianV2'),installDirectory:install});assert.equal(runtime,await realpath(join(parent,'DoudianDiscountGuardianV2')));
  const second=runtimeDirectory({fallback:join(dir,'different/DoudianDiscountGuardianV2'),installDirectory:install});assert.equal(second,runtime);
  await writeFile(join(install,'guardian-runtime.json'),JSON.stringify({schema:1,path:'../secret'}));assert.throws(()=>runtimeDirectory({fallback:dir,installDirectory:install}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('service build identity changes when only UI or version changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-build-'));try{
  await mkdir(join(dir,'src'));await mkdir(join(dir,'public'));await writeFile(join(dir,'src/test.mjs'),'export const x=1;');await writeFile(join(dir,'public/index.html'),'<p>旧界面</p>');await writeFile(join(dir,'package.json'),'{"version":"2.0.0-beta.2"}');
  const before=await projectBuild(dir);await writeFile(join(dir,'public/index.html'),'<p>新界面</p>');const after=await projectBuild(dir);assert.notEqual(after,before);
  await writeFile(join(dir,'package.json'),'{"version":"2.0.0-beta.3"}');assert.notEqual(await projectBuild(dir),after);
 }finally{await rm(dir,{recursive:true,force:true});}
});
