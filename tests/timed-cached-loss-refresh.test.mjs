import test from 'node:test';
import assert from 'node:assert/strict';
import {DoudianPlatform} from '../src/platform.mjs';

test('an old cached timed risk source is scheduled for a fresh read before an export failure becomes a product blocker',async()=>{
 const now=Date.now(),baseline={shopId:'900001',productId:'300001',campaignId:'400001',type:'限时抢购',historyAt:now-100000};
 const c={id:baseline.campaignId,type:'限时抢购',risk:true,status:'已结束',startAt:now-200000,endAt:now-100000};
 const p=new DoudianPlatform({browser:{},policy:{shopId:baseline.shopId}});
 p.inventory={activeComplete:true,listing:{complete:true,observedAt:now,campaigns:[c]},details:new Map([[c.id,{complete:true,observedAt:now-86400000,products:[]}]])};
 await assert.rejects(()=>p.loss(baseline),e=>e.code==='LOSS_EVIDENCE_EXPIRED'&&e.detail.productId===baseline.productId&&e.detail.campaignId===c.id);
});
