import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DedicatedBrowser} from '../../src/browser.mjs';
test('dedicated persistent profile retains platform storage and unexpired login cookies across browser restart',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-profile-persistence-'));
 const server=createServer((req,res)=>{
  if(req.url==='/signin')res.setHeader('Set-Cookie',['guardian-persistent=fixture; Max-Age=86400; Path=/; SameSite=Lax; HttpOnly','guardian-session=fixture; Path=/; SameSite=Lax; HttpOnly']);
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local account session fixture</title>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,b=new DedicatedBrowser(dir,{test:true});
 try{
  await b.open('900001',{profileKey:'signin-stable-profile'});let page=await b.page();await page.goto(base+'/signin');await page.evaluate(()=>localStorage.setItem('fixture-device-id','stable'));
  await b.close();await b.open('900001',{profileKey:'signin-stable-profile'});page=await b.page();await page.goto(base+'/check');
  assert.equal(await page.evaluate(()=>localStorage.getItem('fixture-device-id')),'stable');
  const names=(await b.context.cookies(base)).map(c=>c.name);
  assert.ok(names.includes('guardian-persistent'));assert.ok(names.includes('guardian-session'),'A still-valid session cookie must not be discarded by the program restart');
 }finally{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
