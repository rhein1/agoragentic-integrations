/** Apache-2.0. Bounded HTTP JSON reader; caller owns endpoint and authority selection. */
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function fail(x){throw new Error(x);}
export async function boundedJson(url,{fetchImpl=globalThis.fetch,headers={},method='GET',body,timeoutMs=10000}={}){
  if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_transport');
  const controller=new AbortController();let timer,reader;
  const work=(async()=>{
    const r=await fetchImpl(url,{method,body,headers:{Accept:'application/json',...headers},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    if(r.redirected||(r.url&&r.url!==url)||(r.status>=300&&r.status<400))fail('redirect_refused');
    if(r.status!==200)fail(`http_${Number.isInteger(r.status)?r.status:'unknown'}_not_retried`);
    if(!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))fail('json_required');
    const length=r.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))fail('response_too_large');
    if(!r.body?.getReader)fail('stream_required');reader=r.body.getReader();let size=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144)fail('response_too_large');chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.byteLength;}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let data;try{data=JSON.parse(text);}catch{fail('invalid_json');}
    if(!object(data))fail('object_required');
    return {data,text,http_status:r.status,server_date:r.headers.get('date'),cache_age:r.headers.get('age'),bytes:size};
  })();
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout_not_retried'));},timeoutMs);})]);}
  finally{clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
