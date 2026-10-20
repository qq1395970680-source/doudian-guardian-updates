import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export const UPDATE_REPOSITORY='qq1395970680-source/doudian-guardian-updates';
export const RELEASES_URL=`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;
function versionParts(s){const m=/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(s);if(!m)throw Error('版本格式无效');return[+m[1],+m[2],+m[3],m[4]?{alpha:0,beta:1,rc:2}[m[4]]:3,+(m[5]||0)];}
export function compareVersions(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<x.length;i++){if(x[i]!==y[i])return x[i]-y[i];}return 0;}
function validate(update){
 versionParts(update.version);const name=`DoudianGuardian-Setup-${update.version}-x64.exe`;
 if(update.name!==name||update.url!==`https://github.com/${UPDATE_REPOSITORY}/releases/download/v${update.version}/${name}`||
  !/^[a-f0-9]{64}$/.test(update.sha256)||!Number.isSafeInteger(update.size)||update.size<=0||update.size>2*1024**3)throw Error('GitHub 更新文件的来源、大小或校验值无效');
 return update;
}
export function selectRelease(releases,currentVersion){
 if(!Array.isArray(releases))throw Error('GitHub 返回的版本列表无效');versionParts(currentVersion);
 const list=releases.filter(r=>!r.draft&&/^v\d+\.\d+\.\d+(?:-(alpha|beta|rc)\.\d+)?$/.test(r.tag_name)).sort((a,b)=>compareVersions(b.tag_name.slice(1),a.tag_name.slice(1)));
 if(!list.length)return{state:'unpublished',currentVersion,message:'尚未发布安装包'};
 const r=list[0],version=r.tag_name.slice(1),name=`DoudianGuardian-Setup-${version}-x64.exe`,asset=r.assets?.find(a=>a.name===name&&a.state==='uploaded');
 if(!asset)throw Error('GitHub 版本尚未包含完整安装包');
 const release=validate({version,name,size:asset.size,sha256:String(asset.digest||'').replace(/^sha256:/,''),url:asset.browser_download_url,
  notes:String(r.body||'').slice(0,12000),page:`https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`});
 return{state:compareVersions(version,currentVersion)>0?'available':'current',currentVersion,release,checkedAt:Date.now()};
}
export async function checkForUpdates(currentVersion,{fetcher=fetch}={}){
 const response=await fetcher(RELEASES_URL,{headers:{Accept:'application/vnd.github+json','User-Agent':'DoudianGuardian/'+currentVersion},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(response.status===404?'更新仓库尚未发布版本':`GitHub 暂时无法连接（${response.status}），请稍后重试`);
 const body=await response.text();if(body.length>2*1024**2)throw Error('更新列表过大');return selectRelease(JSON.parse(body),currentVersion);
}
async function githubDownload(url,fetcher,signal,progress){
 let next=url;
 for(let n=0;n<5;n++){
  const u=new URL(next);if(u.protocol!=='https:'||u.username||u.password||u.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('更新下载重定向来源无效');
  progress();const r=await fetcher(next,{redirect:'manual',signal,headers:{'User-Agent':'DoudianGuardian'}});signal.throwIfAborted();progress();
  if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw Error('下载重定向缺少地址');next=new URL(location,next).href;continue;}
  if(!r.ok)throw Error('下载更新失败（'+r.status+'）');return r;
 }throw Error('更新下载重定向过多');
}
export async function downloadUpdate(update,directory,{fetcher=fetch,onProgress=()=>{}}={}){
 validate(update);await mkdir(directory,{recursive:true});const target=join(directory,update.name),partial=target+'.'+randomUUID()+'.part';
 const controller=new AbortController();let idle;
 const progress=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(Error('更新下载连续 60 秒无进展，请稍后重试')),60000);};
 // Slow but progressing connections must not lose an otherwise valid download
 // at a fixed three-minute cutoff. Keep both a stall limit and an overall cap.
 const overall=setTimeout(()=>controller.abort(Error('更新下载超过 30 分钟最长等待，请稍后重试')),30*60000);
 let handle;try{
  const response=await githubDownload(update.url,fetcher,controller.signal,progress);handle=await open(partial,'wx');const hash=createHash('sha256');let size=0,last=0;
  for await(const chunk of response.body){controller.signal.throwIfAborted();if(chunk.length)progress();size+=chunk.length;if(size>update.size)throw Error('更新文件大小校验失败');hash.update(chunk);await handle.write(chunk);
   if(Date.now()-last>150){onProgress({received:size,total:update.size});last=Date.now();}}
  controller.signal.throwIfAborted();clearTimeout(idle);clearTimeout(overall);
  if(size!==update.size||hash.digest('hex')!==update.sha256)throw Error('更新文件 SHA256 或大小校验失败');
  await handle.sync();await handle.close();handle=null;await rename(partial,target);onProgress({received:size,total:size});return target;
 }catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw error;}
 finally{clearTimeout(idle);clearTimeout(overall);await handle?.close();await rm(partial,{force:true});}
}
export async function verifyInstaller(path,update){validate(update);const bytes=await readFile(path);if(bytes.length!==update.size||createHash('sha256').update(bytes).digest('hex')!==update.sha256)throw Error('安装前校验失败');}
