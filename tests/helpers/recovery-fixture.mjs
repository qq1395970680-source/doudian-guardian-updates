export function recoveryTask(index=0,{shopId='900001',phase='verified',skuCount=2}={}){
 const at=Date.now()-index*60000,productId=String(300000+index%21);
 return{id:'task-'+index,shopId,phase,title:'守护2-test'+index,createdAt:at-20000,submittedAt:at-15000,updatedAt:at,
  submitAttempts:phase==='blocked'?0:1,reason:phase==='blocked'?'平台规则尚未确认':null,
  plans:[{shopId,productId,name:'净水器滤芯 '+index,type:'普通降价促销',skippedSkuIds:[],skus:Array.from({length:skuCount},(_,i)=>({id:String(600000+i),name:'滤芯规格 '+(i+1),baseFen:10000+i*1000,discount:50,saleFen:5000+i*500}))}],
  receipt:phase==='verified'?{campaignId:String(700000+index),verifiedAt:at,productCount:1,skuCount,salePriceEvidence:'verified-base-and-discount-with-computed-sale',evidenceFingerprint:'a'.repeat(64)}:null};
}
export function seedRecoveries(journal,tasks){for(const task of tasks){const{id,shopId,phase,updatedAt,...body}=task;journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,shopId,id,phase,JSON.stringify(body),updatedAt);}}
