import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {downloadUpdate,UPDATE_REPOSITORY} from '../src/updates.mjs';

function clocks(t){
 t.mock.timers.enable({apis:['setTimeout']});
 // AbortSignal.timeout uses native timers; route it through the test clock
 // so the original three-minute cutoff is reproduced without a real wait.
 t.mock.method(AbortSignal,'timeout',ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('Timed out','TimeoutError')),ms);return c.signal;});
}
function update(bytes){const version='2.0.0-beta.14',name=`DoudianGuardian-Setup-${version}-x64.exe`;return{version,name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:`https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`};}

test('a progressing verified download can finish beyond three minutes',async t=>{
 clocks(t);const dir=await mkdtemp(join(tmpdir(),'guardian-progress-download-')),bytes=Buffer.alloc(15,7);let signal;
 try{
  const path=await downloadUpdate(update(bytes),dir,{fetcher:async(_url,options)=>{signal=options.signal;return{ok:true,status:200,body:(async function*(){for(const byte of bytes){t.mock.timers.tick(20000);signal.throwIfAborted();yield Buffer.from([byte]);}})()};}});
  assert.deepEqual(await readFile(path),bytes);assert.equal(signal.aborted,false);t.mock.timers.tick(3600000);assert.equal(signal.aborted,false,'completion clears all download timers');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a stalled body aborts and never exposes a partial installer',async t=>{
 clocks(t);const dir=await mkdtemp(join(tmpdir(),'guardian-stalled-download-')),bytes=Buffer.from('ab');
 try{
  await assert.rejects(downloadUpdate(update(bytes),dir,{fetcher:async(_url,{signal})=>({ok:true,status:200,body:(async function*(){yield bytes.subarray(0,1);t.mock.timers.tick(60001);signal.throwIfAborted();yield bytes.subarray(1);})()})}),/下载.*无进展/);
  assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('continuous trickle still has a bounded overall deadline',async t=>{
 clocks(t);const dir=await mkdtemp(join(tmpdir(),'guardian-total-download-')),bytes=Buffer.alloc(100,7);
 try{
  await assert.rejects(downloadUpdate(update(bytes),dir,{fetcher:async(_url,{signal})=>({ok:true,status:200,body:(async function*(){for(const byte of bytes){t.mock.timers.tick(20000);signal.throwIfAborted();yield Buffer.from([byte]);}})()})}),/下载.*最长等待/);
  assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
