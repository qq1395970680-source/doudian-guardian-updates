export function seedPriceQueue(journal,{shopId='900001',pending=500,approved=220}={}) {
 const now=Date.now(),insert=journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)');
 journal.transaction(()=>{
  for(let i=0;i<pending+approved;i++){
   const r={id:shopId+'-review-'+i,key:shopId+'-key-'+i,shopId,productId:String(3000000000000000000n+BigInt(i)),
    name:'测试商品 '+i,status:i<pending?'pending':'approved',createdAt:now+i,expiresAt:now+1800000,skippedSkuIds:[],
    rows:[{id:'sku-'+i,name:'测试规格 '+i,baseFen:10000,previousFen:5000,previousDiscount:50,discount:51,saleFen:5100,evidence:['测试平台明确下限 51 元']}]};
   insert.run(r.id,r.shopId,r.productId,r.status,JSON.stringify(r),r.createdAt);
  }
 });
}
