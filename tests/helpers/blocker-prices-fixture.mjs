import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {Journal} from '../../src/journal.mjs';
import {GuardianService} from '../../src/service.mjs';
import {makePriceReviews} from '../../src/price-review.mjs';
import {priceFixture} from './price-review-fixture.mjs';

import {setOriginalPriceRecoveryPolicy,activeOriginalPriceRecoveryGrant} from '../../src/original-price-recovery-policy.mjs';
export async function blockerFixture(){
 const runtime=await mkdtemp(join(tmpdir(),'guardian-blocker-prices-')),journal=new Journal(':memory:'),now=Date.now()-1000,f=priceFixture(journal,now);
 const review=journal.recordPriceReview(makePriceReviews(f.task,f.probe,now)[0],now);journal.transition(f.task.id,'queued','blocked',{reason:'PRICE_REVIEW_REQUIRED: 平台要求调整价格'},now);
 const platform={progress:{stage:'test'},probe:async()=>({shopId:f.policy.shopId,name:'调价测试店铺'})};
 const service=new GuardianService({journal,platform,policy:f.policy});
 const app=await createApp({config:f.policy,runtime,port:0,dependencies:{journal,service,browser:{close:async()=>{}},platform}});
 journal.putSettings('application',{accounts:[{shopId:f.policy.shopId,originalRiskAllowed:true}]});
 setOriginalPriceRecoveryPolicy(journal,f.policy.shopId,{enabled:true,acceptOriginalPricesOnly:true});const grant=activeOriginalPriceRecoveryGrant(journal,f.policy.shopId);
 const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Guardian-Token':token,Origin:app.url};
 const post=(path,args)=>fetch(app.url+'/api/'+path,{method:'POST',headers,body:JSON.stringify(args)});
 await post('finish-login',{});for(let i=0;i<100&&!app.snapshot().connection;i++)await new Promise(r=>setTimeout(r,10));
 return{app,journal,service,review,f,grant,headers,post,async close(){await app.close();await rm(runtime,{recursive:true,force:true});}};
}
