import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {probeService} from '../desktop/service-controller.mjs';
import {isUpgradeProbeUncertain} from '../desktop/active-upgrade.mjs';

for(const scenario of ['503','403','500','wrong-shop','wrong-build-marker','invalid-json','timeout'])test('only actual maintenance and transport uncertainty are eligible for bounded reprobe: '+scenario,async()=>{
 const server=createServer((_req,res)=>{
  if(scenario==='timeout')return;
  if(['503','403','500'].includes(scenario)){res.writeHead(Number(scenario));res.end('maintenance');return;}
  if(scenario==='invalid-json'){res.end('{ broken json');return;}
  res.end(JSON.stringify({build:scenario==='wrong-build-marker'?'foreign-service':'isolated-headless-journal',shopId:scenario==='wrong-shop'?'900002':'900001',instance:'fixture-instance',sourceBuild:'a'.repeat(64)}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{let caught;try{await probeService({url:'http://127.0.0.1:'+server.address().port,shopId:'900001',timeoutMs:100});}catch(error){caught=error;}
  assert.ok(caught);assert.equal(isUpgradeProbeUncertain(caught),['503','timeout'].includes(scenario));if(scenario==='503')assert.equal(caught.status,503);
 }finally{server.close();server.closeAllConnections();}
});
