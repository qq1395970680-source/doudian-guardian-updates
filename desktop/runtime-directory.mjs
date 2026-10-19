import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join,isAbsolute,basename} from 'node:path';

export function runtimeDirectory({fallback,installDirectory=null}){
 let selected=fallback;
 if(installDirectory){try{const record=JSON.parse(readFileSync(join(installDirectory,'guardian-runtime.json'),'utf8'));
  if(record.schema!==1||!isAbsolute(record.path)||basename(record.path)!=='DoudianDiscountGuardianV2')throw Error('本机数据目录配置无效');selected=record.path;
 }catch(e){if(e.code!=='ENOENT')throw e;}}
 mkdirSync(selected,{recursive:true});const canonical=realpathSync(selected);
 // Persist the physical location across launches from Explorer and packaged
 // hosts with filesystem redirection. This file is local, never distributed.
 if(installDirectory)writeFileSync(join(realpathSync(installDirectory),'guardian-runtime.json'),JSON.stringify({schema:1,path:canonical}));
 return canonical;
}
