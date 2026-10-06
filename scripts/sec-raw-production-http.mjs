import { safeError } from './sec-raw-automation-policy.mjs';

/** 전용 credential을 명시적으로 전달한다. redirect/retry 및 외부 오류 원문 전달을 금지한다. */
export function createBoundedJsonClient({fetchImpl,credential,base,category,timeoutMs=10000,maxBytes=4*1024*1024}) {
  if (typeof fetchImpl!=='function' || typeof credential!=='string' || !credential || /[\r\n]/.test(credential) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>20000) throw safeError('POLICY_INVALID');
  return async(path,{method='GET',body,allowedStatuses=[200],headers={}}={})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(base+path,{method,headers:{...headers,Authorization:`Bearer ${credential}`,
        Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:controller.signal});
      if (!allowedStatuses.includes(response.status)) {await response.body?.cancel().catch(()=>{});throw safeError(category);}
      if ([404,409,422].includes(response.status)) {await response.body?.cancel().catch(()=>{});return {status:response.status};}
      const reader=response.body?.getReader();if (!reader) throw safeError(category);
      const chunks=[];let bytes=0;
      try {
        while (true) {const {done,value}=await reader.read();if (done) break;bytes+=value.byteLength;
          if (bytes>maxBytes) throw safeError(category);chunks.push(value);}
        return {status:response.status,data:JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'))};
      } finally {await reader.cancel().catch(()=>{});}
    } catch {throw safeError(category);} finally {clearTimeout(timer);}
  };
}
