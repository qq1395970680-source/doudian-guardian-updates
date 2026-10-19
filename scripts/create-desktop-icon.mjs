import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
// Editable SVG is the single source for the app, tray, installer and UI icon.
const folder=resolve(import.meta.dirname,'../desktop/assets');await mkdir(folder,{recursive:true});
const svg=await readFile(join(folder,'guardian.svg'),'utf8');
const browser=await chromium.launch({channel:'chromium',headless:true});
try{
 const page=await browser.newPage();const rendered=await page.evaluate(async source=>{
  const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(source);await img.decode();const results=[];
  for(const size of [16,24,32,48,64,128,256,1024]){const c=document.createElement('canvas');c.width=c.height=size;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,size,size);results.push({size,png:c.toDataURL('image/png').split(',')[1]});}return results;
 },svg);
 const sizes=rendered.filter(r=>r.size<=256),header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;const chunks=[];
 sizes.forEach((r,i)=>{const png=Buffer.from(r.png,'base64'),at=6+16*i;header[at]=header[at+1]=r.size===256?0:r.size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(png.length,at+8);header.writeUInt32LE(offset,at+12);offset+=png.length;chunks.push(png);});
 await writeFile(join(folder,'guardian.ico'),Buffer.concat([header,...chunks]));
 const png=Buffer.from(rendered.find(r=>r.size===1024).png,'base64');await writeFile(join(folder,'guardian.png'),png);await writeFile(resolve(import.meta.dirname,'../public/guardian.png'),png);
}finally{await browser.close();}
