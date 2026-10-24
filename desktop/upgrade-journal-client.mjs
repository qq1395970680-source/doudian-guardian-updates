import {spawn} from 'node:child_process';
import {join} from 'node:path';

// SQLite is opened by the bundled Node runtime, not Electron's Node ABI.
// Commands only inspect/backup/verify this program's own database; no import,
// SQL, task mutation, price decision or restoration input is accepted.
export async function upgradeJournalCommand({root,runtime,mode,backupId}){
 return new Promise((accept,reject)=>{
  const child=spawn(join(root,'engine','node.exe'),[join(root,'desktop','upgrade-journal-worker.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='',settled=false;
  const fail=e=>{if(settled)return;settled=true;clearTimeout(timer);reject(e);};
  const timer=setTimeout(()=>{child.kill();fail(Error('数据库维护核验超时，未确认安全接管'));},30000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();fail(Error('数据库核验结果超出上限'));}});
  child.stderr.on('data',chunk=>{if(error.length<4096)error+=chunk;});child.once('error',fail);
  child.once('close',code=>{if(settled)return;if(code!==0){fail(Error(error||'数据库核验失败'));return;}
   try{const value=JSON.parse(output);settled=true;clearTimeout(timer);accept(value);}catch(e){fail(e);}
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({runtime,mode,backupId}));
 });
}
