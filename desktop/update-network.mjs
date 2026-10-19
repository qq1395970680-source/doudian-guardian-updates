export function createUpdateFetcher({directFetch=fetch,systemFetch}){
 return async(url,options={})=>{
  try{return await directFetch(url,options);}
  catch(error){
   // A connectivity failure may use the operating system network. HTTP rate
   // limits are responses, not exceptions, and are never retried here.
   if(options.signal?.aborted||!systemFetch)throw error;
   return await systemFetch(url,options);
  }
 };
}

export function isAllowedUpdateUrl(value,initial=value){
 try{
  const url=new URL(value),root=new URL(initial);
  const hosts=root.hostname==='api.github.com'?['api.github.com']:['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'];
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&hosts.includes(url.hostname);
 }catch{return false;}
}

// Electron net.fetch cancels manual redirects instead of returning the 3xx
// response. Follow in a dedicated memory-only session, whose network hook
// checks EVERY hop before it reaches the network, including the five-hop cap.
// Keep this lazy: Electron sessions may only be created after app readiness.
export function createSystemUpdateFetcher({getSession,allowUrl=isAllowedUpdateUrl}){
 let network;
 return async(url,options={})=>{
  if(options.signal?.aborted)throw options.signal.reason;
  if(!allowUrl(url,url))throw Error('更新网络来源无效');
  if(!network){
   network=getSession();const requests=new Map();
   network.webRequest.onBeforeRequest((details,callback)=>{
    const entry=requests.get(details.id)||{initial:details.url,count:0};entry.count++;
    requests.set(details.id,entry);
    callback({cancel:entry.count>5||!allowUrl(details.url,entry.initial)});
   });
   const finish=details=>requests.delete(details.id);
   network.webRequest.onCompleted(finish);
   network.webRequest.onErrorOccurred(finish);
  }
  return network.fetch(url,{...options,redirect:options.redirect==='manual'?'follow':options.redirect,
   credentials:'omit',cache:'no-store',bypassCustomProtocolHandlers:true});
 };
}
