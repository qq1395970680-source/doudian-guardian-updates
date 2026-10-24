import {upgradeJournalSnapshot} from './upgrade-journal-snapshot.mjs';
let input='';
try{
 for await(const chunk of process.stdin){input+=chunk;if(input.length>8192)throw Error('数据库维护请求过大');}
 const request=JSON.parse(input);
 if(typeof request.runtime!=='string'||!request.runtime)throw Error('缺少本机数据目录');
 const result=await upgradeJournalSnapshot(request);process.stdout.write(JSON.stringify(result));
}catch(error){process.stderr.write(error.message);process.exitCode=1;}
