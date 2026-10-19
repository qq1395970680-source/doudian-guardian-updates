import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),files=[];
async function visit(dir){for(const entry of await readdir(join(root,dir),{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())await visit(p);else files.push(p);}}
for(const dir of ['src','desktop','scripts','tests','public','config'])await visit(dir);
for(const file of files.filter(f=>/\.(mjs|cjs|js)$/.test(f))){const result=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);}
const forbidden=/connectOverCDP|chrome:\/\/extensions|chrome-extension:\/\/|--remote-debugging-port|addInitScript|storageState\(/;
for(const file of files.filter(f=>f.startsWith('src'))){if(forbidden.test(await readFile(join(root,file),'utf8')))throw Error('Forbidden browser attachment or clock patch in '+file);}
const hashes=[];for(const path of files)hashes.push({path,sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')});
await mkdir(join(root,'artifacts'),{recursive:true});await writeFile(join(root,'artifacts','source-check.json'),JSON.stringify({at:Date.now(),node:process.version,syntax:true,sourceBoundaries:true,hashes},null,2));
console.log(JSON.stringify({syntaxFiles:files.filter(f=>f.endsWith('.mjs')).length,sourceFiles:files.length,sourceBoundaries:true}));
