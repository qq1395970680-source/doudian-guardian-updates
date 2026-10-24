import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveProfileSession,loadProfileSession} from '../src/profile-session.mjs';
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
