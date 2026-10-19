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
