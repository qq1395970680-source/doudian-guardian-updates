import {fingerprint,saleFen} from '../../src/policy.mjs';
import {campaignChoice} from '../../src/campaign-choice.mjs';

// An isolated, independent limited-campaign rejection. The live app never
// writes fixtures or probes unapproved new prices to manufacture this evidence.
export function seedLimitedRejection(journal,fixture,review,{at=review.createdAt-10,minFen=7200}={}){
 const type='限量抢购',target=campaignChoice(type),taskId='limited-rejection-task',id='limited-rejection-review';
 const {fingerprint:oldHash,...original}=fixture.plan,plan={...original,...target};plan.fingerprint=fingerprint(plan);
 const reason='PRICE_REVIEW_REQUIRED: 活动价不得低于近15天最低价（'+(minFen/100)+'元）';
 const body={title:'测试限量独立拒绝',submitAttempts:0,reason,plans:[plan]};
 journal.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId,review.shopId,'limited-fixture','blocked',JSON.stringify(body),at);
 const rows=review.rows.map((row,i)=>({...row,discount:i===0?52:row.previousDiscount,saleFen:saleFen(row.baseFen,i===0?52:row.previousDiscount),bounds:i===0?{minFen}:{},evidence:i===0?['活动价不得低于近15天最低价（'+(minFen/100)+'元）']:[]}));
 const value={...review,id,key:'limited-source-key',type,rules:target.rules,rows,status:'superseded',createdAt:at,taskId};
 journal.db.prepare('INSERT INTO price_reviews VALUES(?,?,?,?,?,?)').run(id,value.shopId,value.productId,value.status,JSON.stringify(value),at);
 return value;
}
