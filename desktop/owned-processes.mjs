import {spawn} from 'node:child_process';
import {join} from 'node:path';
export async function ownedProcessCommand(mode,expected,identity,{executable=join(import.meta.dirname,'assets','GuardianOwnedProcesses.exe').replace(/app\.asar([\\/])/,'app.asar.unpacked$1')}={}){
 return new Promise((accept,reject)=>{
  const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',error='';
  const timer=setTimeout(()=>{child.kill();reject(Error('进程维护助手超时，未确认关闭完成'));},60000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2*1024*1024){child.kill();reject(Error('进程维护结果过大'));}});
  child.stderr.on('data',chunk=>{error+=chunk;});child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('close',code=>{clearTimeout(timer);if(code!==0){reject(Error(error||'进程维护未完成'));return;}try{accept(JSON.parse(output));}catch(e){reject(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({mode,expected,identity}));
 });
}
