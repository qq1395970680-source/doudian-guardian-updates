import {inflateRawSync} from 'node:zlib';
import {GuardError,requireThat,id,saleFen} from './policy.mjs';

const MAX_BYTES=4*1024*1024;
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
function xmlPart(bytes,name){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=MAX_BYTES,'REMOVAL_EXPORT_FORMAT','剔除明细文件大小无效');
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 requireThat(end>=0&&bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&
  end+22+bytes.readUInt16LE(end+20)===bytes.length,'REMOVAL_EXPORT_FORMAT','剔除明细不是完整单卷表格');
 const count=bytes.readUInt16LE(end+10),directory=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
 requireThat(count>0&&count<=256&&count===bytes.readUInt16LE(end+8)&&directory+size===end,'REMOVAL_EXPORT_FORMAT','表格目录不完整');
 let offset=directory,result=null;const names=new Set(),decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
 for(let i=0;i<count;i++){
  requireThat(offset+46<=end&&bytes.readUInt32LE(offset)===0x02014b50,'REMOVAL_EXPORT_FORMAT','表格目录损坏');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),checksum=bytes.readUInt32LE(offset+16);
  const compressed=bytes.readUInt32LE(offset+20),uncompressed=bytes.readUInt32LE(offset+24),n=bytes.readUInt16LE(offset+28);
  const next=offset+46+n+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
  requireThat(next<=end&&!(flags&1)&&[0,8].includes(method),'REMOVAL_EXPORT_FORMAT','表格压缩格式不支持');
  const path=decode(bytes.subarray(offset+46,offset+46+n));
  requireThat(!names.has(path)&&!path.includes('..')&&!path.startsWith('/')&&!path.includes('\\')&&!/vbaProject/i.test(path),'REMOVAL_EXPORT_FORMAT','表格条目无效或重复');names.add(path);
  if(path===name){
   requireThat(uncompressed<=MAX_BYTES&&local+30<directory&&bytes.readUInt32LE(local)===0x04034b50,'REMOVAL_EXPORT_FORMAT','表格数据超出边界');
   const ln=bytes.readUInt16LE(local+26),start=local+30+ln+bytes.readUInt16LE(local+28);
   requireThat(decode(bytes.subarray(local+30,local+30+ln))===path&&start+compressed<=directory,'REMOVAL_EXPORT_FORMAT','表格数据位置不符');
   const body=bytes.subarray(start,start+compressed),data=method===8?inflateRawSync(body,{maxOutputLength:MAX_BYTES}):body;
   requireThat(data.length===uncompressed&&crc(data)===checksum,'REMOVAL_EXPORT_FORMAT','剔除明细校验不符');result=decode(data);
  }
  offset=next;
 }
 requireThat(offset===end&&result!==null,'REMOVAL_EXPORT_FORMAT','剔除明细工作表缺失');return result;
}
function decodeText(value){
 requireThat(!/[<>]/.test(value),'REMOVAL_EXPORT_FORMAT','单元格包含不支持的内容');
 return value.replace(/&([^;]+);/g,(_all,key)=>{
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(named,key))return named[key];
  requireThat(/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(key),'REMOVAL_EXPORT_FORMAT','未知 XML 实体');
  const point=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  requireThat(point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff),'REMOVAL_EXPORT_FORMAT','无效 XML 字符');return String.fromCodePoint(point);
 });
}
// Only plain text cells in the observed official export schema are accepted.
// No formulas, external links, macros or text in the workbook are executed.
export function readRemovalWorkbook(bytes){
 const xml=xmlPart(bytes,'xl/worksheets/sheet1.xml');
 requireThat(!/<!DOCTYPE|<!ENTITY|<f(?:\s|>)/i.test(xml),'REMOVAL_EXPORT_FORMAT','不接受公式或外部实体');
 const body=xml.match(/<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/)?.[1];
 requireThat(body,'REMOVAL_EXPORT_FORMAT','剔除明细缺少数据');
 const rows=[];
 for(const match of body.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
  const row=[],cells=[...match[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
  requireThat(cells.length===5,'REMOVAL_EXPORT_FORMAT','剔除明细列数变化');
  for(let i=0;i<cells.length;i++){
   const [,attributes,cell]=cells[i],ref=attributes.match(/\br="([A-E])(\d+)"/),kind=attributes.match(/\bt="([^"]+)"/)?.[1];
   requireThat(ref?.[1]===String.fromCharCode(65+i)&&Number(ref[2])===rows.length+1&&kind==='str','REMOVAL_EXPORT_FORMAT','剔除明细单元格格式变化');
   const value=cell.match(/^\s*<v(?:\s[^>]*)?>([\s\S]*?)<\/v>\s*$/)?.[1];
   requireThat(value!==undefined,'REMOVAL_EXPORT_FORMAT','剔除明细不是纯文本');row.push(decodeText(value).trim());
  }
  rows.push(row);requireThat(rows.length<=10001,'REMOVAL_EXPORT_FORMAT','剔除明细行数超限');
 }
 requireThat(rows.length>1&&JSON.stringify(rows[0])===JSON.stringify(['商品ID','商品名','渠道id','渠道类型','失败原因']),
  'REMOVAL_EXPORT_FORMAT','剔除明细表头变化');
 const records=rows.slice(1).map(([productId,name,channel,type,reason])=>{
  id(productId);requireThat(name&&reason&&reason.length<=10000&&(channel==='--'&&type==='--'||channel==='0'&&type==='主品'),
   'REMOVAL_EXPORT_FORMAT','剔除明细缺少原因或存在未支持的渠道');
  return{productId,name,reason};
 });
 requireThat(new Set(records.map(r=>r.productId)).size===records.length,'REMOVAL_EXPORT_FORMAT','剔除明细商品重复');return records;
}

export function parseRemovalPriceRatio(reason){
 requireThat(typeof reason==='string','REMOVAL_RULE_UNKNOWN','平台剔除原因未完整读取');
 const lines=reason.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),ratios=[];
 for(const line of lines){
  const match=line.match(/^该商品各SKU售卖价[，,]最高价需在最低价的(\d+(?:\.\d{1,3})?)倍以内[，,]请修改后再提交[。.;；]/);
  requireThat(match,'REMOVAL_RULE_UNKNOWN','平台已剔除该商品，退出原因尚无可验证的价格约束，保留原价待核实');
  const denominator=10**((match[1].split('.')[1]||'').length),numerator=Math.round(Number(match[1])*denominator);
  requireThat(numerator>=denominator&&numerator<=1000*denominator,'REMOVAL_RULE_UNKNOWN','平台价差倍数无效');
  ratios.push({numerator,denominator});
 }
 requireThat(ratios.length,'REMOVAL_RULE_UNKNOWN','平台剔除原因未完整读取');
 return ratios.reduce((a,b)=>a.numerator*b.denominator<=b.numerator*a.denominator?a:b);
}

export function checkRemovalPrices(plan,removal){
 if(!removal)return;
 const ratio=parseRemovalPriceRatio(removal.reason);
 const prices=plan.skus.map(s=>s.saleFen),min=Math.min(...prices),max=Math.max(...prices);
 if(max*ratio.denominator<=min*ratio.numerator)return;
 const floor=Math.ceil(max*ratio.denominator/ratio.numerator),increaseOnlyPossible=plan.skus.every(s=>saleFen(s.baseFen,95)>=floor);
 throw new GuardError('SKU_RATIO_REVIEW_REQUIRED',
  `平台要求最高规格价不超过最低价的 ${ratio.numerator/ratio.denominator} 倍；当前为 ${(max/min).toFixed(2)} 倍。${increaseOnlyPossible?'需要逐规格核对调价方案':'仅提高低价规格无法满足，保留当前价格等待处理'}，未重复创建。`,
  {productId:plan.productId,maxToMinRatio:ratio.numerator/ratio.denominator,minFen:min,maxFen:max,requiredMinFen:floor,increaseOnlyPossible,reason:removal.reason});
}
