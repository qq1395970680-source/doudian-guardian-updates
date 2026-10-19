import { chromium } from 'playwright';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { id, requireThat } from './policy.mjs';
import {randomUUID} from 'node:crypto';

export class DedicatedBrowser {
  constructor(root, { viewport = {width:1440,height:960}, deviceScaleFactor = 1, test = false } = {}) {
    this.root = resolve(root);this.viewport=viewport;this.deviceScaleFactor=deviceScaleFactor;this.test=test;
    this.context=null;this.loginMode=false;this.shopId=null;
  }
  async openLogin(){const profileKey='signin-'+randomUUID();await this.open(null,{login:true,profileKey});return profileKey;}
  async open(shopId, {login=false,profileKey=null}={}) {
    if(shopId!==null)id(shopId,'店铺ID');
    requireThat(shopId!==null||login,'ACCOUNT_UNKNOWN','尚未识别店铺');
    const key=profileKey||'shop-'+shopId;requireThat(/^(shop-\d+|signin-[a-zA-Z0-9-]+)$/.test(key),'PROFILE_SCOPE','专用资料目录无效');
    requireThat(!this.context,'BROWSER_BUSY','专用浏览器正在使用');
    await mkdir(this.root,{recursive:true});
    const root=await realpath(this.root),profile=join(root,'profiles',key);
    await mkdir(profile,{recursive:true});const actual=await realpath(profile),inside=relative(root,actual);
    requireThat(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'PROFILE_SCOPE','浏览器资料必须位于本程序专用目录');
    // Never attach to or copy the user's Chrome profile. Native headless runs
    // normal rendering without patching visibility, animation clocks or timers.
    this.context=await chromium.launchPersistentContext(actual,{channel:'chromium',headless:!login,
      chromiumSandbox:true,viewport:this.viewport,deviceScaleFactor:this.deviceScaleFactor,
      locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:true,timeout:45000});
    this.shopId=shopId;this.loginMode=login;
    this.context.setDefaultTimeout(20000);this.context.setDefaultNavigationTimeout(45000);
    if(this.test)await this.context.route('**/*',route=>{
      const url=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(url.hostname)?route.continue():route.abort();
    });
    return this.context;
  }
  async page() { requireThat(this.context,'NO_BROWSER','专用浏览器未启动');return this.context.newPage(); }
  async close() { const context=this.context;this.context=null;this.loginMode=false;this.shopId=null;if(context)await context.close(); }
  async failure(page,taskId,stage,error,observation=null) {
    const folder=join(this.root,'evidence',taskId.replace(/[^a-zA-Z0-9-]/g,''));await mkdir(folder,{recursive:true});
    await page.screenshot({path:join(folder,stage+'.png'),fullPage:false}).catch(()=>{});
    // No cookies, browser storage, request headers, or auth-bearing URLs.
    await writeFile(join(folder,stage+'.json'),JSON.stringify({at:Date.now(),stage,code:error.code||'PAGE_ERROR',message:String(error.message).slice(0,1200),...(observation?{observation}: {})},null,2),'utf8');
  }
}
