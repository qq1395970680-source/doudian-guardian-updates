import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveProfileSession,loadProfileSession} from '../src/profile-session.mjs';
import {DedicatedBrowser} from '../src/browser.mjs';
test('session vault encrypts cookies for this Windows user and exact dedicated profile without changing expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-vault-')),a=join(dir,'a'),b=join(dir,'b');await mkdir(a);await mkdir(b);
 const cookies=[{name:'fixture',value:'fixture-secret-value',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'},
  {name:'expired',value:'do-not-copy',domain:'127.0.0.1',path:'/',expires:1,httpOnly:true,secure:false,sameSite:'Lax'}];
 try{
  await saveProfileSession(a,cookies);const cipher=await readFile(join(a,'guardian-session.v1.dpapi'));
  assert.equal(cipher.includes(Buffer.from('fixture-secret-value')),false);assert.deepEqual(await loadProfileSession(a),[cookies[0]]);
  await writeFile(join(b,'guardian-session.v1.dpapi'),cipher);await assert.rejects(()=>loadProfileSession(b),{code:'PROFILE_VAULT_UNAVAILABLE'});
  await saveProfileSession(a,[]);assert.deepEqual(await loadProfileSession(a),[],'Logout clears the saved session rather than restoring a prior one');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('persistent cookies are encrypted too, retain their actual expiry and are never revived after expiration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-persistent-vault-')),now=Date.now();
 const session={name:'fixture-session',value:'session-private-fixture',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'};
 const persistent={...session,name:'fixture-persistent',value:'persistent-private-fixture',expires:now/1000+60};
 const expired={...persistent,name:'fixture-expired',expires:now/1000-1};
 try{
  const saved=await saveProfileSession(dir,[session,persistent,expired],now);assert.equal(saved.cookieCount,2);
  const cipher=await readFile(join(dir,'guardian-session.v1.dpapi'));assert.equal(cipher.includes(Buffer.from(persistent.value)),false);
  assert.deepEqual(await loadProfileSession(dir,now),[session,persistent]);
  assert.deepEqual(await loadProfileSession(dir,now+61000),[session],'Platform expiry is not extended by the encrypted backup');
  await saveProfileSession(dir,[],now+62000);assert.deepEqual(await loadProfileSession(dir,now+62000),[],'Explicitly cleared cookies cannot be restored from an earlier backup');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('close drains an older periodic cookie save and freshly checkpoints an intervening logout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'guardian-logout-close-'));let reads=0,finishRead;
 const cookie={name:'fixture-old',value:'old-synthetic-session',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'};
 const browser=new DedicatedBrowser(dir,{test:true});browser.profilePath=dir;
 browser.context={cookies:async()=>++reads===1?new Promise(resolve=>{finishRead=resolve;}):[],close:async()=>{}};
 try{
  const pending=browser.checkpointSession();while(!finishRead)await new Promise(r=>setTimeout(r,1));
  const closing=browser.close();finishRead([cookie]);await Promise.all([pending,closing]);
  assert.equal(reads,2);assert.deepEqual(await loadProfileSession(dir),[]);assert.equal(browser.context,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
