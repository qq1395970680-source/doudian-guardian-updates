import {requireThat,fingerprint} from './policy.mjs';
import {priceMode,validateFixedPrice} from './price-mode.mjs';
import {inflateRawSync} from 'node:zlib';
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
// Exact six-column fixed-price template downloaded from the platform's native
// template-type dialog. The example row is intentionally not copied.
export const fixedPriceHeaders=[headers[0],headers[1],
 '一口价（必填）\n\n1、 0<一口价<sku价格；\n2、价格规则：\n优惠力度至少95折，例如sku原价为100元，一口价须≤95元；\n不满足价格校验规则的sku无法上传成功！\n\n3、一口价金额最多支持两位小数；',
 headers[3],
 '每人限购（必填）\n\n1、1=<限购数量<=20；\n\n2、若活动设置为不限制每人限购,则此列信息填写无效;',
 headers[5]+'\n'];
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
 const mode=priceMode(plans[0]);
 requireThat(plans.every(p=>p.shopId===plans[0].shopId&&p.type===plans[0].type&&fingerprint(p.rules)===fingerprint(plans[0].rules)&&priceMode(p)===mode),'WORKBOOK_GROUP','导入集合跨店、定价方式或规则不同');
 requireThat(mode!=='fixed'||['限时抢购','限量抢购'].includes(plans[0].type),'FIXED_ACTIVITY_UNAVAILABLE','此活动类型尚无已核对的一口价导入方式');
 const seen=new Set(),rows=[mode==='fixed'?fixedPriceHeaders:headers];
 for(const p of plans)for(const s of p.skus){
  requireThat(typeof p.productId==='string'&&/^\d{3,25}$/.test(p.productId)&&typeof s.id==='string'&&/^\d{3,25}$/.test(s.id)&&!seen.has(s.id),'WORKBOOK_ID','导入编号不完整或重复');seen.add(s.id);
  if(mode==='fixed'){
   validateFixedPrice(s);
   requireThat(s.saleFen*100<=s.baseFen*95,'WORKBOOK_PRICE','一口价超出官方模板已核对的95折价格上限，保留原金额等待平台核验');
   rows.push([p.productId,s.id,s.saleFen/100,null,1,null]);
  }else{requireThat(Number.isInteger(s.discount)&&s.discount>=10&&s.discount<=95,'WORKBOOK_PRICE','导入折扣无效');rows.push([p.productId,s.id,s.discount/100,null,1,null]);}
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

// Read only the two plain-text XML parts needed for the official header. This
// parser never evaluates formulas or workbook links, and bounds ZIP inflation.
function templatePart(bytes,wanted,{optional=false}={}){
 const limit=4*1024*1024;
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=limit,'FIXED_TEMPLATE_FORMAT','一口价官方模板大小无效');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 requireThat(end>=0&&bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&end+22+bytes.readUInt16LE(end+20)===bytes.length,'FIXED_TEMPLATE_FORMAT','一口价模板不是完整单卷表格');
 const count=bytes.readUInt16LE(end+10),directory=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
 requireThat(count>0&&count<=256&&count===bytes.readUInt16LE(end+8)&&directory+size===end,'FIXED_TEMPLATE_FORMAT','一口价模板目录无效');
 const names=new Set(),decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);let offset=directory,result=null;
 for(let i=0;i<count;i++){
  requireThat(offset+46<=end&&bytes.readUInt32LE(offset)===0x02014b50,'FIXED_TEMPLATE_FORMAT','一口价模板目录损坏');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),sum=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),uncompressed=bytes.readUInt32LE(offset+24),n=bytes.readUInt16LE(offset+28),local=bytes.readUInt32LE(offset+42),next=offset+46+n+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  requireThat(next<=end&&!(flags&1)&&[0,8].includes(method),'FIXED_TEMPLATE_FORMAT','一口价模板压缩格式不支持');
  const path=decode(bytes.subarray(offset+46,offset+46+n));requireThat(!names.has(path)&&!path.includes('..')&&!path.startsWith('/')&&!path.includes('\\')&&!/vbaProject|externalLinks/i.test(path),'FIXED_TEMPLATE_FORMAT','一口价模板包含无效内容');names.add(path);
  if(path===wanted){
   requireThat(uncompressed<=limit&&local+30<directory&&bytes.readUInt32LE(local)===0x04034b50,'FIXED_TEMPLATE_FORMAT','一口价模板数据越界');
   const ln=bytes.readUInt16LE(local+26),start=local+30+ln+bytes.readUInt16LE(local+28);requireThat(decode(bytes.subarray(local+30,local+30+ln))===path&&start+compressed<=directory,'FIXED_TEMPLATE_FORMAT','一口价模板数据位置不符');
   const raw=bytes.subarray(start,start+compressed),body=method===8?inflateRawSync(raw,{maxOutputLength:limit}):raw;requireThat(body.length===uncompressed&&crc(body)===sum,'FIXED_TEMPLATE_FORMAT','一口价模板校验不符');result=decode(body);
  }offset=next;
 }
 requireThat(offset===end&&(result!==null||optional),'FIXED_TEMPLATE_FORMAT','一口价模板工作表缺失');return result;
}
function plainXmlText(value){
 requireThat(!/[<>]/.test(value),'FIXED_TEMPLATE_FORMAT','一口价模板不是纯文本');
 return value.replace(/&([^;]+);/g,(_all,key)=>{
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(named,key))return named[key];
  requireThat(/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(key),'FIXED_TEMPLATE_FORMAT','一口价模板含未知字符实体');const point=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));requireThat(point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff),'FIXED_TEMPLATE_FORMAT','一口价模板字符无效');return String.fromCodePoint(point);
 });
}
export function assertFixedPriceTemplate(bytes){
 const sheet=templatePart(bytes,'xl/worksheets/sheet1.xml'),shared=templatePart(bytes,'xl/sharedStrings.xml',{optional:true});
 requireThat(!/<!DOCTYPE|<!ENTITY|<f(?:\s|>)/i.test(sheet+(shared||'')),'FIXED_TEMPLATE_FORMAT','一口价模板含不支持的公式或实体');
 const texts=shared?[...shared.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m=>[...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t=>plainXmlText(t[1])).join('')):[];
 const first=sheet.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/)?.[1];requireThat(first,'FIXED_TEMPLATE_FORMAT','一口价模板缺少首行表头');
 const cells=[...first.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];requireThat(cells.length===6,'FIXED_TEMPLATE_FORMAT','一口价模板列数已变化');
 const values=cells.map(([,attr,cell],i)=>{
  requireThat(attr.match(/\br="([A-F])1"/)?.[1]===String.fromCharCode(65+i),'FIXED_TEMPLATE_FORMAT','一口价模板表头列位置已变化');const type=attr.match(/\bt="([^"]+)"/)?.[1],value=cell.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
  if(type==='s'){requireThat(/^\d+$/.test(value||'')&&Number(value)<texts.length,'FIXED_TEMPLATE_FORMAT','一口价模板共享表头无效');return texts[Number(value)];}
  if(type==='inlineStr')return [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t=>plainXmlText(t[1])).join('');
  requireThat(type==='str'&&value!==undefined,'FIXED_TEMPLATE_FORMAT','一口价模板表头类型不支持');return plainXmlText(value);
 });
 const normalize=v=>v.replace(/\r\n?/g,'\n').trim();requireThat(values.every((v,i)=>normalize(v)===normalize(fixedPriceHeaders[i])),'FIXED_TEMPLATE_FORMAT','当前活动的一口价官方模板与已核对列规则不同，保留原价等待适配');
 return{source:'current-native-fixed-price-template',schema:1,headersFingerprint:fingerprint(values.map(normalize)),maximumPercent:95,decimalPlaces:2};
}
