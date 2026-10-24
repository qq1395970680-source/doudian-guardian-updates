import {readFile,mkdir,cp,rename,access,realpath} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
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
export async function prepareBackend({bundleRoot,runtime}){
 // Running code lives outside the replaceable installer directory. Upgrades do
 // not overwrite a live Node/Chromium process or its login/SQLite directories.
 const bundleId=await validateBundle(bundleRoot),versions=join(runtime,'versions'),target=join(versions,bundleId);
 await mkdir(versions,{recursive:true});
 try{await access(target);await validateBundle(target);return await realpath(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 const staging=join(versions,bundleId+'.install-'+process.pid+'-'+Date.now());
 await cp(bundleRoot,staging,{recursive:true,errorOnExist:true,force:false});await validateBundle(staging);await rename(staging,target);return await realpath(target);
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
