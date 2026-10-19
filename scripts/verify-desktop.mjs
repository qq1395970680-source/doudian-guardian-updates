import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {validateBundle} from '../desktop/backend.mjs';
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const root=resolve(import.meta.dirname,'..'),app=resolve(process.argv[2]||join(root,'desktop-dist/win-unpacked'));
const service=join(app,'resources/service'),source=join(app,'resources/source');
const bundleId=await validateBundle(service);
for(const item of JSON.parse(await readFile(join(source,'source-manifest.json'),'utf8'))){
 const data=await readFile(join(source,item.path));
 if(createHash('sha256').update(data).digest('hex').toUpperCase()!==item.sha256)throw Error('Source archive mismatch: '+item.path);
 if(!data.equals(await readFile(join(root,item.path))))throw Error('Source differs from working project: '+item.path);
}
const asarFile=join(app,'resources/app.asar');let desktopFiles=0;
async function visit(folder){for(const e of await readdir(join(root,folder),{withFileTypes:true})){const path=join(folder,e.name);if(e.isDirectory())await visit(path);else{
 const packed=asar.extractFile(asarFile,path);if(!packed.equals(await readFile(join(root,path))))throw Error('Desktop code mismatch: '+path);desktopFiles++;
}}}await visit('desktop');
for(const dir of ['src','public']){
 async function compare(folder){for(const e of await readdir(join(root,folder),{withFileTypes:true})){const path=join(folder,e.name);if(e.isDirectory())await compare(path);else if(!(await readFile(join(service,path))).equals(await readFile(join(root,path))))throw Error('Backend mismatch: '+path);}}
 await compare(dir);
}
if(!(await readFile(join(service,'config/default.json'))).equals(await readFile(join(root,'config/default.json'))))throw Error('Default configuration mismatch');
const configs=await readdir(join(service,'config'));if(configs.length!==1||configs[0]!=='default.json')throw Error('Release carries a shop configuration');
if(!asar.extractFile(asarFile,join('src','updates.mjs')).equals(await readFile(join(root,'src/updates.mjs'))))throw Error('Updater module mismatch');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const installer=join(root,'desktop-dist',`DoudianGuardian-Setup-${version}-x64.exe`),bytes=await readFile(installer);
const result={at:Date.now(),version,app,bundleId,desktopFiles,serviceAndSourceMatch:true,installer,installerBytes:bytes.length,installerSha256:createHash('sha256').update(bytes).digest('hex'),containsUserData:false};
await mkdir(join(root,'artifacts'),{recursive:true});await writeFile(join(root,'artifacts/desktop-package-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
