import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ensureService} from '../desktop/service-controller.mjs';
const root=resolve(import.meta.dirname,'..'),runtime=process.env.GUARDIAN_RUNTIME||join(process.env.LOCALAPPDATA,'DoudianDiscountGuardianV2'),url='http://127.0.0.1:19417';
await mkdir(runtime,{recursive:true});
await ensureService({url,launch:async()=>{const out=openSync(join(runtime,'service-out.log'),'a'),err=openSync(join(runtime,'service-error.log'),'a');
 try{const child=spawn(process.execPath,[join(root,'src/server.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,GUARDIAN_RUNTIME:runtime,...(existsSync(join(root,'browsers'))?{PLAYWRIGHT_BROWSERS_PATH:join(root,'browsers')}:{})}});await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();}finally{closeSync(out);closeSync(err);}
}});console.log(url);
