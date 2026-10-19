import {readFile,mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const source=resolve(import.meta.dirname,'..');
const result=JSON.parse((await readFile(join(source,'artifacts','package-result.json'),'utf8')).replace(/^\uFEFF/,'')),root=result.directory;
const manifest=JSON.parse((await readFile(join(root,'manifest-sha256.json'),'utf8')).replace(/^\uFEFF/,''));
for(const file of manifest){
 const path=resolve(root,file.path),inside=relative(root,path);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));
 assert.equal(createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase(),file.sha256);
}
async function sameDirectory(dir){for(const e of await readdir(join(source,dir),{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await sameDirectory(p);else assert.deepEqual(await readFile(join(root,p)),await readFile(join(source,p)),p);}}
for(const dir of ['src','public','config'])await sameDirectory(dir);
assert.ok((await readFile(join(root,'engine','LICENSE.txt'))).length>10000);
assert.equal(spawnSync(join(root,'engine','node.exe'),['--version'],{encoding:'utf8'}).stdout.trim(),'v24.18.0');
process.env.PLAYWRIGHT_BROWSERS_PATH=join(root,'browsers');
const {chromium}=await import(pathToFileURL(join(root,'node_modules','playwright','index.mjs')).href);
const profile=await mkdtemp(join(tmpdir(),'guardian-package-smoke-'));let context;
try{
 context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,chromiumSandbox:true});
 const page=await context.newPage();await page.setContent('<title>独立后台离线验收</title><h1>本地运行</h1>');assert.equal(await page.title(),'独立后台离线验收');assert.equal(await page.evaluate(()=>document.visibilityState),'visible');
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
const report={at:Date.now(),directory:root,manifestFiles:manifest.length,sourceFilesMatch:true,bundledNode:true,bundledChromium:true,profileWasTemporary:true,liveAcceptance:false};
await writeFile(join(source,'artifacts','package-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
