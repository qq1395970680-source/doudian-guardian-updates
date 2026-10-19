import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions,selectRelease,UPDATE_REPOSITORY,downloadUpdate} from '../src/updates.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const bytes=Buffer.from('test installer'),version='2.0.0-beta.3';
function release(){const name=`DoudianGuardian-Setup-${version}-x64.exe`;return{tag_name:'v'+version,draft:false,prerelease:true,body:'新版说明',html_url:`https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,assets:[{name,size:bytes.length,state:'uploaded',digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),browser_download_url:`https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`}]};}
test('GitHub releases supports beta ordering without downgrades or draft updates',()=>{
 assert.ok(compareVersions('2.0.0-beta.12','2.0.0-beta.3')>0);assert.ok(compareVersions('2.0.0','2.0.0-beta.12')>0);
 assert.equal(selectRelease([release()],'2.0.0-beta.2').state,'available');assert.equal(selectRelease([release()],'2.0.0-beta.3').state,'current');
 assert.equal(selectRelease([{...release(),draft:true}],'2.0.0-beta.2').state,'unpublished');
 assert.equal(selectRelease([release()],'2.0.0').state,'current');
});
test('update requires exact repository, installer filename, size and SHA256',()=>{
 for(const change of [{digest:null},{browser_download_url:'https://evil.example/setup.exe'},{size:0},{name:'ReplyPilot.exe'}]){
  const r=release();Object.assign(r.assets[0],change);assert.throws(()=>selectRelease([r],'2.0.0-beta.2'));
 }
});
test('download hash is checked before exposing an installable path',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-update-'));
 try{const update=selectRelease([release()],'2.0.0-beta.2').release;
  const path=await downloadUpdate(update,dir,{fetcher:async()=>new Response(bytes)});assert.deepEqual(await readFile(path),bytes);
  await assert.rejects(downloadUpdate(update,dir,{fetcher:async()=>new Response('bad installer')}),/校验|大小/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
