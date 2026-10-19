import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {validateBundle} from '../desktop/backend.mjs';
// electron-builder filters a mapping's top-level node_modules. The two runtime
// modules are mapped explicitly; fail before creating an installer if anything
// was omitted, pruned or changed. Never trust a successful pack exit alone.
export default async function afterPack({appOutDir}){
 await validateBundle(join(appOutDir,'resources/service'));
 const source=join(appOutDir,'resources/source');
 for(const item of JSON.parse(await readFile(join(source,'source-manifest.json'),'utf8'))){
  const bytes=await readFile(join(source,item.path));
  if(createHash('sha256').update(bytes).digest('hex').toUpperCase()!==item.sha256)throw Error('Packaged source is incomplete: '+item.path);
 }
 const asar=createRequire(import.meta.url)('@electron/asar'),root=resolve(import.meta.dirname,'..');
 async function checkDesktop(dir){for(const e of await readdir(join(root,dir),{withFileTypes:true})){
  const file=join(dir,e.name);if(e.isDirectory())await checkDesktop(file);else{
   const embedded=asar.extractFile(join(appOutDir,'resources/app.asar'),file);
   if(!embedded.equals(await readFile(join(root,file))))throw Error('Desktop code or icon omitted: '+file);
  }
 }}await checkDesktop('desktop');
 console.log('Desktop backend and editable source manifests verified before installer creation.');
}
