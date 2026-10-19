import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import electron from 'electron';

test('Electron system-network downloads validate redirects and stream the response',{timeout:45000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-update-network-'));
 const env={...process.env,GUARDIAN_UPDATE_TEST_RUNTIME:runtime};delete env.ELECTRON_RUN_AS_NODE;
 try{
  const child=spawn(electron,[resolve('tests/fixtures/update-network-electron.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const timer=setTimeout(()=>child.kill(),30000);
  const code=await new Promise((ok,no)=>{child.once('error',no);child.once('exit',ok);}).finally(()=>clearTimeout(timer));
  assert.equal(code,0,output);assert.match(output,/UPDATE_NETWORK_PASS/);
 }finally{await rm(runtime,{recursive:true,force:true});}
});
