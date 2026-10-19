// Runs from an immutable application-owned runtime, never from the installer
// directory that NSIS replaces. It does not stop or kill the business service.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve,dirname,basename} from 'node:path';
const jobPath=resolve(process.argv[2]),job=JSON.parse(await readFile(jobPath,'utf8'));
const log=async(state,detail='')=>writeFile(join(dirname(jobPath),'installation-result.json'),JSON.stringify({at:Date.now(),state,detail,version:job.version},null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 if(!Number.isInteger(job.pid)||job.pid<=0||!/^[a-f0-9]{64}$/.test(job.sha256)||dirname(resolve(job.installer))!==dirname(jobPath)||basename(job.installer)!==`DoudianGuardian-Setup-${job.version}-x64.exe`)throw Error('更新任务参数无效');
 if(basename(job.executable)!=='DoudianGuardian.exe'||dirname(job.executable)!==job.installDir)throw Error('安装目录无效');
 const bytes=await readFile(job.installer);if(bytes.length!==job.size||createHash('sha256').update(bytes).digest('hex')!==job.sha256)throw Error('安装前 SHA256 校验失败');
 let exited=false;for(let i=0;i<240;i++){try{process.kill(job.pid,0);}catch(e){if(e.code==='ESRCH'){exited=true;break;}throw e;}await sleep(500);}
 if(!exited)throw Error('程序窗口尚未退出，已取消安装');
 await log('installing');const installer=spawn(job.installer,['/S','/D='+job.installDir],{windowsHide:true,stdio:'ignore'});
 const code=await new Promise((accept,reject)=>{installer.once('error',reject);installer.once('exit',accept);});if(code!==0)throw Error('安装器退出码 '+code);
 await log('installed');const desktop=spawn(job.executable,[],{detached:true,stdio:'ignore',windowsHide:false});desktop.once('error',e=>void log('restart-failed',e.message));desktop.unref();
}catch(e){await log('failed',e.message);process.exitCode=1;}
