import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const file=runtime=>join(resolve(runtime),'updates','active-upgrade-pending.json');
export async function readUpgradeHandoff({runtime,targetBuild,targetVersion}){
 let value;try{value=JSON.parse(await readFile(file(runtime),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(value.schema!==1||value.runtime!==resolve(runtime)||value.targetBuild!==targetBuild||value.targetVersion!==targetVersion||!['prepared','finalized','launching'].includes(value.phase)||!/^[a-f0-9-]{36}$/.test(value.cutoverId||'')||!value.expected||!Array.isArray(value.processIds)||typeof value.resumeOnLaunch!=='boolean')throw Error('未完成更新记录与本机或当前安装包不匹配，未启动另一后台');
 return value;
}
export async function saveUpgradeHandoff(value){
 const path=file(value.runtime);await mkdir(join(resolve(value.runtime),'updates'),{recursive:true});const temp=path+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(value),{encoding:'utf8',flush:true});await rename(temp,path);return value;
}
export async function completeUpgradeHandoff(options,status){
 const value=await readUpgradeHandoff(options);if(!value)return false;
 if(!['finalized','launching'].includes(value.phase)||status.sourceBuild!==value.targetBuild||status.version!==value.targetVersion||status.instance===value.expected.instance||status.shopId!==value.expected.shopId)throw Error('新版实际身份与已核验的切换记录不符');
 await rename(file(options.runtime),join(resolve(options.runtime),'updates','active-upgrade-completed-'+value.cutoverId+'.json'));return true;
}
