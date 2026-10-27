import {readFile,mkdir,cp,rename,access,realpath} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';

export async function validateBundle(root){
 const manifestBytes=await readFile(join(root,'manifest-sha256.json'));
 const manifest=JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/,''));
 for(const item of manifest){
  const file=resolve(root,item.path),rel=relative(root,file);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('发行包文件路径无效');
  const bytes=await readFile(file);
  if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex').toUpperCase()!==item.sha256.toUpperCase())throw Error('发行包文件校验失败：'+item.path);
 }
 for(const file of ['engine/node.exe','src/server.mjs','config/default.json'])await access(join(root,file));
 return createHash('sha256').update(manifestBytes).digest('hex').slice(0,24);
}
async function existingBackend(target,bundleId){
 try{await access(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 try{
  if(await validateBundle(target)!==bundleId)throw Error('目标清单与本次安装包不一致');
  return await realpath(target);
 }catch(error){throw Object.assign(Error('新版目标目录校验失败，原目录已保留：'+error.message,{cause:error}),{code:'BACKEND_TARGET_INVALID'});}
}
export async function prepareBackend({bundleRoot,runtime,renameDirectory=rename,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 // Running code lives outside the replaceable installer directory. Upgrades do
 // not overwrite a live Node/Chromium process or its login/SQLite directories.
 const bundleId=await validateBundle(bundleRoot),versions=join(runtime,'versions'),target=join(versions,bundleId);
 await mkdir(versions,{recursive:true});
 const existing=await existingBackend(target,bundleId);if(existing)return existing;
 const staging=join(versions,bundleId+'.install-'+process.pid+'-'+randomUUID());
 await cp(bundleRoot,staging,{recursive:true,errorOnExist:true,force:false});
 if(await validateBundle(staging)!==bundleId)throw Object.assign(Error('复制期间安装包发生变化，未启动后台，临时目录已保留'),{code:'BACKEND_SOURCE_CHANGED'});
 // Windows can temporarily hold a freshly copied directory open. Retry only
 // its rename, preserving the already verified files and every business record.
 // A complete concurrent target may be reused; an incomplete target is never
 // overwritten or mistaken for a missing directory.
 const delays=[100,250,500,1000,2000,4000],retryable=new Set(['EPERM','EBUSY','EACCES','EEXIST','ENOTEMPTY']);
 for(let attempt=0;;attempt++){
  try{
   await renameDirectory(staging,target);
   const installed=await existingBackend(target,bundleId);
   if(!installed)throw Object.assign(Error('新版目录切换后目标已消失，未启动后台，须重新核对'),{code:'BACKEND_TARGET_MISSING'});
   return installed;
  }catch(error){
   if(!retryable.has(error.code))throw error;
   const current=await existingBackend(target,bundleId);if(current)return current;
   if(attempt===delays.length)throw Object.assign(Error('新版目录切换仍被占用，完整的新版本临时目录已保留；未覆盖旧后台或任务：'+error.message,{cause:error}),
    {code:error.code,staging,target});
   await sleep(delays[attempt]);
  }
 }
}
export async function launchBackend({root,runtime,shopId,resumeOnUpgrade=false}){
 await mkdir(runtime,{recursive:true});
 root=await realpath(root);runtime=await realpath(runtime);
 const out=openSync(join(runtime,'service-out.log'),'a'),err=openSync(join(runtime,'service-error.log'),'a');let child;
 try{
  child=spawn(join(root,'engine','node.exe'),['src/server.mjs',...(shopId?['--shop',shopId]:[])],{cwd:root,windowsHide:true,detached:true,
   stdio:['ignore',out,err],env:{...process.env,GUARDIAN_RUNTIME:runtime,GUARDIAN_UPGRADE_RESUME:resumeOnUpgrade===true?'1':'0',PLAYWRIGHT_BROWSERS_PATH:join(root,'browsers')}});
  await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
 }finally{closeSync(out);closeSync(err);}
 return child.pid;
}
