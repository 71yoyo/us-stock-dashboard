import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';
import { assertPolicyMessage, safeError } from './sec-raw-automation-policy.mjs';
import { assertReadiness } from './sec-raw-automation-readiness.mjs';

/** 자동화 전용 단일 POST 경로다. 역사 승인서/반복 전수 검증에 의존하지 않고 run receipt를 요구한다. retry는 없다. */
export function createAutomationQueueTransport({fetchImpl=globalThis.fetch,credential,timeoutMs=10000,now=Date.now}={}) {
  if (typeof fetchImpl!=='function' || typeof credential!=='string' || !credential || /[\r\n]/.test(credential) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>20000) throw safeError('POLICY_INVALID');
  return Object.freeze({kind:'official-rest',send:async(message,{policy,receipt,runId,enqueue=false}={})=>{
    assertReadiness(receipt,policy,runId,now()); assertPolicyMessage(policy,message);
    try { await validateCompactSecRawMessage(message); } catch { throw safeError('MESSAGE_INVALID'); }
    if (!enqueue || !policy.productionEnqueueEnabled) throw safeError('POLICY_INVALID');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${policy.target.accountId}/queues/${policy.target.queueId}/messages`,{
        method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},
        // /messages는 단건 계약이다. batch wrapper는 ticker별 INTENT와 응답 의미를 흐리므로 사용하지 않는다.
        body:JSON.stringify({body:message,content_type:'json'}),signal:controller.signal,redirect:'error'});
      if (response.status>=400 && response.status<500) {
        await response.body?.cancel().catch(()=>{});
        return {kind:'rejected',category:[401,403].includes(response.status)?'QUEUE_AUTH':response.status===404?'QUEUE_TARGET':'QUEUE_REJECTED',http:response.status};
      }
      if (response.status<200 || response.status>=300) { await response.body?.cancel().catch(()=>{}); return {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:response.status}; }
      // 성공 body도 크기 제한을 지킨다. Queue Push는 messageId가 없을 수 있으므로 성공 envelope만 확인한다.
      const reader=response.body?.getReader(); if (!reader) return {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:response.status};
      let bytes=0; const chunks=[];
      try {
        while (true) { const {done,value}=await reader.read(); if (done) break; bytes+=value.byteLength;
          if (bytes>65536) return {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:response.status}; chunks.push(value); }
        let body; try {body=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));} catch {return {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:response.status};}
        return body?.success===true ? {kind:'accepted',category:'ACCEPTED',http:response.status} : {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:response.status};
      } finally { await reader.cancel().catch(()=>{}); }
    } catch { return {kind:'ambiguous',category:'QUEUE_AMBIGUOUS',http:null}; }
    finally { clearTimeout(timer); }
  }});
}
