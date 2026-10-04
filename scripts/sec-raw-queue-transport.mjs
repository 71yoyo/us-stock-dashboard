import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';
import { validatePromotionEnvelope, assertHistoricalScopeProcessed } from './sec-raw-promotion.mjs';

const safeError = (code,status=null,attempts=0,cloudflareCodes=[]) => Object.assign(new Error(`SEC_RAW_QUEUE_${code}`),
  {code,status,attempts,cloudflareCodes});

/** CLI도 서버 message/stack/header가 아니라 허용된 category와 숫자만 출력한다. */
export function queueTransportFailure(error) {
  const allowed=['POLICY','IDENTITY','CREDENTIAL_OR_DB','REMOTE_IDENTITY','SCOPE','HTTP','INVALID_RESPONSE',
    'TIMEOUT_AMBIGUOUS','NETWORK_AMBIGUOUS'];
  return {code:allowed.includes(error?.code)?error.code:'DISCOVERY_FAILED',
    httpStatus:Number.isInteger(error?.status) && error.status>=100 && error.status<=599?error.status:null,
    attempts:Number.isInteger(error?.attempts) && error.attempts>=0 && error.attempts<=3?error.attempts:0,
    cloudflareCodes:Array.isArray(error?.cloudflareCodes)?error.cloudflareCodes.filter(code=>
      Number.isSafeInteger(code) && code>=1000 && code<10000000):[]};
}

/** API body/header는 예외에 포함하지 않는다. 공식 REST만 사용하며 기본값은 미전송이다. */
export function createSecRawQueueTransport({accountId,queueId,queueName,credential,DB,envelope,checkpoint,
  enabled=false,dryRun=true,fetchImpl=globalThis.fetch,timeoutMs=10000,maxRetries=0,
  backoffMs=1000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2
    || !Number.isInteger(backoffMs) || backoffMs < 1 || backoffMs > 10000) throw safeError('POLICY');
  const validateScope = () => {
    validatePromotionEnvelope(envelope,{checkpoint});
    if (accountId !== envelope.queue.accountId || queueId !== envelope.queue.queueId
      || queueName !== envelope.queue.name) throw safeError('IDENTITY');
  };
  async function request(method,body) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}${method === 'POST' ? '/messages' : ''}`,
        {method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},
          ...(body ? {body:JSON.stringify(body)} : {}),signal:controller.signal});
      let json;
      try { json = await response.json(); } catch { throw safeError('INVALID_RESPONSE',response.status); }
      const codes = Array.isArray(json?.errors) ? json.errors.map(row=>row.code)
        .filter(code=>Number.isSafeInteger(code) && code>=1000 && code<10000000) : [];
      if (!response.ok || json?.success !== true || codes.length) throw safeError('HTTP',response.status,0,codes);
      return {status:response.status,result:json.result};
    } catch (error) {
      if (error?.code && error.message === `SEC_RAW_QUEUE_${error.code}`) throw error;
      // timeout/network는 수신 서버가 이미 받았을 수 있어 자동 재송신하지 않는다. consumer identity로 중복을 보호한다.
      throw safeError(controller.signal.aborted ? 'TIMEOUT_AMBIGUOUS' : 'NETWORK_AMBIGUOUS');
    } finally { clearTimeout(timeout); }
  }
  return { async send(input) {
    const {message} = await validateCompactSecRawMessage(input);
    validateScope();
    if (!envelope.tickers.includes(message.ticker) || Number(message.filing.cik) !== Number(envelope.ciks[message.ticker])) throw safeError('SCOPE');
    if (!enabled || dryRun) return {status:'dry-run',idempotencyKey:message.idempotencyKey,attempts:0};
    if (!DB || typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential)) throw safeError('CREDENTIAL_OR_DB');
    await assertHistoricalScopeProcessed(DB,envelope);
    const metadata = await request('GET');
    if (metadata.result?.queue_id !== queueId || metadata.result?.queue_name !== queueName) throw safeError('REMOTE_IDENTITY',metadata.status);
    for (let attempt=0;attempt<=maxRetries;attempt++) {
      validateScope();
      try {
        const response = await request('POST',{body:message,content_type:'json'});
        return {status:'queued',httpStatus:response.status,attempts:attempt+1,idempotencyKey:message.idempotencyKey};
      } catch (error) {
        error.attempts = attempt+1;
        // 401/403/404, 형식 불명 응답, 통신 불확실성은 재송신 금지. 429/5xx만 명시한 최대 2회까지 허용한다.
        if (error.code !== 'HTTP' || !(error.status === 429 || error.status >= 500)
          || attempt === maxRetries) throw error;
        await sleep(backoffMs * (attempt+1));
      }
    }
  } };
}
