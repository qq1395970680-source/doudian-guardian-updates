import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
export async function projectBuild(root){
 const hash=createHash('sha256');hash.update(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version);
 for(const dir of ['src','public'])for(const name of (await readdir(join(root,dir))).sort()){
  if(dir==='src'&&!name.endsWith('.mjs'))continue;
  hash.update(dir+'/'+name).update(await readFile(join(root,dir,name)));
 }
 return hash.digest('hex');
}
