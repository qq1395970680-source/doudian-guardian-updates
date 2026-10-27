import {readFile,writeFile,readdir,mkdir,cp,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import './create-desktop-icon.mjs';
import {projectBuild} from '../src/build.mjs';
const helperBuild=spawnSync('pwsh.exe',['-NoLogo','-File',resolve(import.meta.dirname,'build-owned-processes.ps1')],{stdio:'inherit',windowsHide:true});
if(helperBuild.status!==0)throw Error('Owned process helper build failed');
const vaultBuild=spawnSync('pwsh.exe',['-NoLogo','-File',resolve(import.meta.dirname,'build-profile-vault.ps1')],{stdio:'inherit',windowsHide:true});
if(vaultBuild.status!==0)throw Error('Profile session vault build failed');
const root=resolve(import.meta.dirname,'..'),stage=join(root,'.desktop');
await cp(join(root,'desktop/assets'),join(root,'build-assets'),{recursive:true});
// This is build-only staging, never a runtime or a user-data directory.
if(relative(root,stage)!=='.desktop')throw Error('Invalid staging directory');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
const service=join(stage,'service'),source=join(stage,'source');await mkdir(service);await mkdir(source);
for(const dir of ['src','public'])await cp(join(root,dir),join(service,dir),{recursive:true});
await mkdir(join(service,'native'));await cp(join(root,'desktop/assets/GuardianProfileVault.exe'),join(service,'native/GuardianProfileVault.exe'));
await mkdir(join(service,'config'));await cp(join(root,'config/default.json'),join(service,'config/default.json'));
await mkdir(join(service,'scripts'));await cp(join(root,'scripts/start-local.mjs'),join(service,'scripts/start-local.mjs'));
await mkdir(join(service,'desktop'));
for(const file of ['service-controller.mjs','backend-upgrade.mjs','readonly-stage.mjs','upgrade-journal-worker.mjs','upgrade-journal-snapshot.mjs'])
 await cp(join(root,'desktop',file),join(service,'desktop',file));
for(const file of ['package.json','package-lock.json','README.md','USER-GUIDE.md','DEVELOPMENT.md','Start.ps1'])await cp(join(root,file),join(service,file));
await mkdir(join(service,'node_modules'));
// The runtime dependency closure is exactly Playwright + playwright-core.
// Electron and electron-builder are build/UI dependencies, not backend modules.
for(const name of ['playwright','playwright-core'])await cp(join(root,'node_modules',name),join(service,'node_modules',name),{recursive:true});
await mkdir(join(service,'engine'));
if(process.version!=='v24.18.0')throw Error('Build requires the pinned Node v24.18.0 runtime');
await cp(process.execPath,join(service,'engine','node.exe'));
const license=join(root,'artifacts/node-v24.18.0-LICENSE.txt');await access(license);await cp(license,join(service,'engine/LICENSE.txt'));
const browserSource=process.env.GUARDIAN_BUILD_CHROMIUM||join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1248');
await cp(browserSource,join(service,'browsers/chromium-1248'),{recursive:true});
for(const path of ['src','public','desktop','tests','scripts','package.json','package-lock.json','electron-builder.json','README.md','DEVELOPMENT.md','USER-GUIDE.md','Start.ps1','.gitignore'])await cp(join(root,path),join(source,path),{recursive:true});
await mkdir(join(source,'config'));await cp(join(root,'config/default.json'),join(source,'config/default.json'));
await mkdir(join(source,'artifacts'),{recursive:true});await cp(license,join(source,'artifacts/node-v24.18.0-LICENSE.txt'));
async function manifest(folder){const rows=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else {const b=await readFile(p);rows.push({path:relative(folder,p),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex').toUpperCase()});}}}await walk(folder);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
await writeFile(join(service,'bundle-info.json'),JSON.stringify({sourceBuild:await projectBuild(root),desktopVersion:JSON.parse(await readFile(join(root,'package.json'))).version,node:process.version,browser:'chromium-1248'},null,2));
const serviceFiles=await manifest(service);await writeFile(join(service,'manifest-sha256.json'),JSON.stringify(serviceFiles,null,2));
await writeFile(join(source,'source-manifest.json'),JSON.stringify(await manifest(source),null,2));
console.log(JSON.stringify({prepared:true,serviceFiles:serviceFiles.length,sourceFiles:(await manifest(source)).length,containsUserData:false}));
