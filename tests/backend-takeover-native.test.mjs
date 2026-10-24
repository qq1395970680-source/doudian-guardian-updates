import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Journal} from '../src/journal.mjs';
import {upgradeService} from '../desktop/service-controller.mjs';
import {repairReadonlyService} from '../desktop/read-repair.mjs';
import {ownedProcessCommand} from '../desktop/owned-processes.mjs';
import {upgradeJournalSnapshot} from '../desktop/upgrade-journal-snapshot.mjs';

for(const hiddenUnknown of [false,true])test(`native legacy busy takeover preserves full SQLite and only replaces a safe owned process: hiddenUnknown=${hiddenUnknown}`,{skip:process.platform!=='win32',timeout:120000},async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'guardian-native-upgrade-')),root=join(runtime,'versions','legacy'),target=join(runtime,'versions','next');
 const journal=new Journal(join(runtime,'guardian.sqlite'));const insert=journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)');
 for(let i=0;i<105;i++)insert.run('task-'+i,'900001','key-'+i,hiddenUnknown&&i===104?'unknown':'verified',JSON.stringify({plans:[],submitAttempts:1,riskAttempts:0}),i+1);
 journal.putSettings('application',{selected:'900001',accounts:[{shopId:'900001',originalRiskAllowed:true}]});
 journal.putSettings('900001',{executionEnabled:true,autoStart:true});
 journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run('price','900001','800001','approved','{"approved":true,"saleFen":6532}',1);
 const before=await upgradeJournalSnapshot({runtime,mode:'inspect'});let oldChild,newChild,launches=0;
 async function prepare(directory,isNew){
  await mkdir(join(directory,'src'),{recursive:true});await mkdir(join(directory,'engine'));await mkdir(join(directory,'config'));
  await copyFile(process.execPath,join(directory,'engine','node.exe'));
  await writeFile(join(directory,'config','default.json'),'{}');
  await writeFile(join(directory,'bundle-info.json'),JSON.stringify({sourceBuild:(isNew?'b':'a').repeat(64)}));
  const code=`import{createServer}from'node:http';import{writeFile}from'node:fs/promises';
const runtime=${JSON.stringify(runtime)},root=${JSON.stringify(directory)},startedAt=Date.now(),target=${isNew};let running=true;
const status=()=>({build:'isolated-headless-journal',version:target?'2.0.0-beta.37':'2.0.0-beta.30',sourceBuild:(target?'b':'a').repeat(64),instance:target?'new-native':'old-native',startedAt,shopId:'900001',running,busy:!target,unknown:0,action:null,loginOpen:false,tasks:Array.from({length:100},()=>({phase:'verified'})),progress:{stage:'核对当前活动',read:10,total:20}});
const server=createServer((q,r)=>{if(q.url==='/api/status')return r.end(JSON.stringify(status()));if(q.url==='/api/stop'){running=false;return r.end(JSON.stringify({ok:true,...status()}));}if(q.method==='POST'){r.writeHead(400);return r.end('{"ok":false,"message":"busy"}');}r.end('<script nonce="'+'a'.repeat(64)+'"></script>');});
await new Promise(r=>server.listen(Number(process.env.FIXTURE_PORT||0),'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
await writeFile(runtime+'/service-status.json',JSON.stringify({pid:process.pid,url,shopId:'900001',startedAt,sourceBuild:status().sourceBuild,sourceRoot:root}));console.log(JSON.stringify({url}));`;
  await writeFile(join(directory,'src','server.mjs'),code);
  const manifest=[];for(const path of ['src/server.mjs','engine/node.exe','config/default.json','bundle-info.json']){
   const data=await readFile(join(directory,path));manifest.push({path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  }
  await writeFile(join(directory,'manifest-sha256.json'),JSON.stringify(manifest));
 }
 async function launch(directory,port){
  const child=spawn(join(directory,'engine','node.exe'),['src/server.mjs'],{cwd:directory,windowsHide:true,env:{...process.env,FIXTURE_PORT:String(port||0)},stdio:['ignore','pipe','pipe']});
  const [chunk]=await once(child.stdout,'data');return{child,url:JSON.parse(chunk.toString()).url};
 }
 try{
  await prepare(root,false);await prepare(target,true);const first=await launch(root);oldChild=first.child;
  const result=await upgradeService({url:first.url,expectedBuild:'b'.repeat(64),expectedVersion:'2.0.0-beta.37',timeoutMs:5000,stallMs:100,pollMs:100,
   takeover:({original,shouldContinue})=>repairReadonlyService({url:first.url,runtime,expectedInstance:original.instance,shouldContinue,launchAfterRepair:false,
    inspect:e=>ownedProcessCommand('inspect',e),terminate:(e,identity)=>ownedProcessCommand('terminate',e,identity),
    journalCheck:(mode,backupId)=>upgradeJournalSnapshot({runtime,mode,backupId})}),
   start:async()=>{launches++;newChild=(await launch(target,new URL(first.url).port)).child;}});
  if(hiddenUnknown){
   assert.equal(result.state,'blocked');assert.equal(result.code,'UPGRADE_PENDING_SUBMISSIONS');assert.equal(launches,0);assert.equal(oldChild.exitCode,null);
   assert.equal(journal.db.prepare("SELECT phase FROM tasks WHERE id='task-104'").get().phase,'unknown');
  }else{
   assert.equal(result.state,'upgraded');assert.equal(result.status.sourceBuild,'b'.repeat(64));assert.equal(launches,1);
   assert.notEqual(oldChild.exitCode,null);
  }
  const after=await upgradeJournalSnapshot({runtime,mode:'inspect'});assert.equal(after.totalTasks,105);assert.equal(after.protectedFingerprint,before.protectedFingerprint);
 }finally{
  for(const child of [oldChild,newChild])if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  journal.close();await rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
