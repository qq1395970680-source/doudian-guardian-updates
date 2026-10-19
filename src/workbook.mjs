import {requireThat,fingerprint} from './policy.mjs';
// Six-column official discount template observed 2026-10-18. All identifiers
// remain XML strings; no decimal-number conversion, macros or remote content.
export const headers=[
 '商品id（必填）\n\n1、单次最多支持上传200个商品',
 'SKUID（必填）\n\n1、可以针对同一商品的不同SKU分别设置优惠，每个SKU为一行，对应同一个商品id（参见示例数据）\n2、skuid可以通过抖店-商品管理页面-导出查询商品按钮获取',
 '折扣（必填）\n\n1、0<折扣<1，0.95代表95折；\n2、价格规则：\n优惠力度至少95折；\n不满足价格校验规则的sku无法上传成功！\n2、折扣最多支持2位小数；',
 '此列无需填写\n\n活动库存已升级为活动限量，活动限量暂不支持Excel设置',
 '每人限购（必填）\n\n1、1=<限购数量<=20；\n\n2、若活动设置为不限制每人限购,则此列信息填写无效;',
 '提示：\n1、第二行为示例数据，上传时须删除；\n2、表格中已经填写的活动参数在表格上传成功后均可在页面批量或逐个修改；\n3、请勿在此列填写任何信息、否则会导致导入失败'
];
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function crc(data){let n=0xffffffff;for(const byte of data){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
export function zip(files){
 const local=[],central=[];let offset=0;
 for(const [name,text]of Object.entries(files)){
  const path=Buffer.from(name),data=Buffer.from(text),sum=crc(data),h=Buffer.alloc(30),c=Buffer.alloc(46);
  h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(33,12);h.writeUInt32LE(sum,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(path.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(33,14);c.writeUInt32LE(sum,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(path.length,28);c.writeUInt32LE(offset,42);
  local.push(h,path,data);central.push(c,path);offset+=h.length+path.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
export function makeWorkbook(plans){
 requireThat(plans.length>0&&plans.length<=200&&new Set(plans.map(p=>p.productId)).size===plans.length,'WORKBOOK_GROUP','导入商品集合无效');
 requireThat(plans.every(p=>p.shopId===plans[0].shopId&&p.type===plans[0].type&&fingerprint(p.rules)===fingerprint(plans[0].rules)),'WORKBOOK_GROUP','导入集合跨店或规则不同');
 const seen=new Set(),rows=[headers];
 for(const p of plans)for(const s of p.skus){
  requireThat(typeof p.productId==='string'&&/^\d{3,25}$/.test(p.productId)&&typeof s.id==='string'&&/^\d{3,25}$/.test(s.id)&&!seen.has(s.id),'WORKBOOK_ID','导入编号不完整或重复');seen.add(s.id);
  requireThat(Number.isInteger(s.discount)&&s.discount>=10&&s.discount<=95,'WORKBOOK_PRICE','导入折扣无效');rows.push([p.productId,s.id,s.discount/100,null,1,null]);
 }
 const sheet=rows.map((r,i)=>`<row r="${i+1}">${r.map((v,j)=>{const ref=String.fromCharCode(65+j)+(i+1);return v===null?`<c r="${ref}"/>`:typeof v==='number'?`<c r="${ref}" t="n"><v>${v}</v></c>`:`<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;}).join('')}</row>`).join('');
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
 return zip({
  '[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  '_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml':`<styleSheet xmlns="${ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><dimension ref="A1:F${rows.length}"/><sheetData>${sheet}</sheetData></worksheet>`
 });
}
