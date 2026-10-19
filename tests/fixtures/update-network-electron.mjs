import {app,session} from 'electron';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createUpdateFetcher,createSystemUpdateFetcher} from '../../desktop/update-network.mjs';
app.setPath('userData',process.env.GUARDIAN_UPDATE_TEST_RUNTIME);
void app.whenReady().then(async()=>{
let forbiddenHits=0,loopHits=0;
const server=createServer((req,res)=>{
 if(req.url==='/start'){res.writeHead(302,{Location:'/asset'});res.end();}
 else if(req.url==='/bad'){res.writeHead(302,{Location:'/forbidden'});res.end();}
 else if(req.url==='/forbidden'){forbiddenHits++;res.end('must not reach this endpoint');}
 else if(req.url==='/loop'){loopHits++;res.writeHead(302,{Location:'/loop'});res.end();}
 else if(req.url==='/slow'){res.writeHead(200);res.write('start');setTimeout(()=>res.end('end'),2000);}
 else if(req.url==='/rate'){res.writeHead(429);res.end('rate limit');}
 else {res.end('fixture-installer');}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try{
 const base=`http://127.0.0.1:${server.address().port}`;
 const systemFetch=createSystemUpdateFetcher({getSession:()=>session.fromPartition('guardian-update-network-test',{cache:false}),
  allowUrl:url=>url.startsWith(base+'/')&&!url.endsWith('/forbidden')});
 const fetcher=createUpdateFetcher({directFetch:async()=>{throw Error('fixture direct connection unavailable');},systemFetch});
 const response=await fetcher(base+'/start',{redirect:'manual',signal:AbortSignal.timeout(10000)});
 assert.equal(await response.text(),'fixture-installer');
 await assert.rejects(()=>fetcher(base+'/bad',{redirect:'manual'}));assert.equal(forbiddenHits,0);
 await assert.rejects(()=>fetcher(base+'/loop',{redirect:'manual'}));assert.equal(loopHits,5);
 await assert.rejects(()=>fetcher(base+'/start',{redirect:'error'}));
 assert.equal((await fetcher(base+'/rate')).status,429);
 const controller=new AbortController();const slow=await fetcher(base+'/slow',{signal:controller.signal});controller.abort();
 await assert.rejects(()=>slow.text());
 // Subsequent requests still work after cancellation and failed redirects.
 assert.equal(await(await fetcher(base+'/start',{redirect:'manual'})).text(),'fixture-installer');
 console.log('UPDATE_NETWORK_PASS');
}catch(error){console.error(error);process.exitCode=1;}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));app.exit(process.exitCode||0);}
});
