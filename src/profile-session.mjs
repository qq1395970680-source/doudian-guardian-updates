import {readFile,writeFile,rename,access,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {requireThat} from './policy.mjs';
const root=resolve(import.meta.dirname,'..'),max=8*1024*1024;
async function vault(mode,profile,bytes){
 requireThat(process.platform==='win32','PROFILE_VAULT_UNAVAILABLE','当前系统无法加密保存登录会话');
 let executable=join(root,'native','GuardianProfileVault.exe');
 try{await access(executable);}catch{executable=join(root,'desktop','assets','GuardianProfileVault.exe');await access(executable);}
 const binding=createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex');
 return new Promise((yes,no)=>{
  const p=spawn(executable,[mode,binding],{windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks=[];let size=0,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?no(Object.assign(Error('登录会话加密保存或读取失败，原资料保留'),{code:'PROFILE_VAULT_UNAVAILABLE'})):yes(value);};
  const timer=setTimeout(()=>{p.kill();finish(true);},10000);timer.unref();
  p.on('error',()=>finish(true));p.stdin.on('error',()=>{});p.stderr.on('data',()=>{});
  p.stdout.on('data',b=>{size+=b.length;if(size>max*2){p.kill();finish(true);}else chunks.push(b);});
  p.on('close',code=>{
   if(code!==0)return finish(true);
   const text=Buffer.concat(chunks).toString('ascii');if(!/^[a-zA-Z0-9+/=\r\n]+$/.test(text))return finish(true);
   const value=Buffer.from(text,'base64');if(value.length>max)return finish(true);finish(null,value);
  });
  p.stdin.end(bytes.toString('base64'));
 });
}
export async function saveProfileSession(profile,cookies,now=Date.now()){
 requireThat(Array.isArray(cookies)&&cookies.length<=10000,'PROFILE_SESSION_LIMIT','登录会话超过保存上限');
 const session=cookies.filter(c=>c.expires===-1);
 const bytes=Buffer.from(JSON.stringify({schema:1,savedAt:now,cookies:session}),'utf8');
 requireThat(bytes.length<=max,'PROFILE_SESSION_LIMIT','登录会话超过保存上限');
 const encrypted=await vault('protect',profile,bytes),path=join(profile,'guardian-session.v1.dpapi'),temp=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temp,encrypted,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}
 return{savedAt:now,cookieCount:session.length};
}
export async function loadProfileSession(profile,now=Date.now()){
 let encrypted;try{encrypted=await readFile(join(profile,'guardian-session.v1.dpapi'));}catch(error){if(error.code==='ENOENT')return[];throw error;}
 requireThat(encrypted.length<=max,'PROFILE_SESSION_LIMIT','已保存登录会话超过读取上限');
 const value=JSON.parse((await vault('unprotect',profile,encrypted)).toString('utf8'));
 requireThat(value.schema===1&&Number.isFinite(value.savedAt)&&value.savedAt<=now+5000&&Array.isArray(value.cookies)&&value.cookies.length<=10000,
  'PROFILE_SESSION_INVALID','已保存登录会话格式无效，原资料保留');
 requireThat(value.cookies.every(c=>c&&typeof c.name==='string'&&typeof c.value==='string'&&typeof c.domain==='string'&&typeof c.path==='string'&&c.expires===-1&&
  typeof c.httpOnly==='boolean'&&typeof c.secure==='boolean'&&['Strict','Lax','None'].includes(c.sameSite)),
  'PROFILE_SESSION_INVALID','已保存登录会话字段无效，原资料保留');
 return value.cookies;
}
