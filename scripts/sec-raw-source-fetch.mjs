import { assertSymbol, normalizeCik, safeError } from './sec-raw-automation-policy.mjs';
const sleepDefault = ms => new Promise(resolve=>setTimeout(resolve,ms));

/** 전체 본문/연락처를 로그로 만들지 않고 streaming byte 상한을 먼저 강제한다. */
async function readJson(response, maxBytes, signal) {
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(response.headers.get('content-type') ?? '')) throw safeError('SOURCE_INVALID');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length)>maxBytes)) throw safeError('SOURCE_TOO_LARGE');
  if (!response.body) throw safeError('SOURCE_INVALID');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw safeError('SOURCE_TOO_LARGE');
      chunks.push(value);
    }
    try { return {data:JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')),bytes}; }
    catch { throw safeError('SOURCE_INVALID'); }
  } finally { await reader.cancel().catch(()=>{}); }
}
function validateSource(data,category,{ticker,cik}) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || normalizeCik(data.cik) !== normalizeCik(cik)) throw safeError('SOURCE_INVALID');
  if (category === 'companyfacts') {
    if (!data.facts || typeof data.facts !== 'object' || Array.isArray(data.facts)) throw safeError('SOURCE_INVALID');
  } else {
    const recent = data.filings?.recent;
    if (!recent || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.filingDate) || !Array.isArray(recent.form) ||
        recent.accessionNumber.length !== recent.filingDate.length || recent.accessionNumber.length !== recent.form.length ||
        !Array.isArray(data.tickers) || !data.tickers.includes(ticker)) throw safeError('SOURCE_INVALID');
  }
  return data;
}
/** 요청 시작을 직렬화해 종목/endpoint/retry를 합쳐 전역 1 req/s를 지킨다. 실제 호출은 명시적 호출 때만 발생한다. */
export function createSecSourceFetcher({fetchImpl=globalThis.fetch,userAgent,now=Date.now,sleep=sleepDefault,random=Math.random,
  timeoutMs=20000,maxBytes=32*1024*1024,maxFetchAttempts=300,maxProviderRequests=300,signal}={}) {
  if (typeof userAgent !== 'string' || !userAgent.trim() || /[\r\n]/.test(userAgent) || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>20000 || !Number.isSafeInteger(maxBytes) || maxBytes<1 ||
      !Number.isSafeInteger(maxFetchAttempts) || maxFetchAttempts<1 || maxFetchAttempts>300 ||
      !Number.isSafeInteger(maxProviderRequests) || maxProviderRequests<1 || maxProviderRequests>300) throw safeError('POLICY_INVALID');
  let total = 0, requests = 0, nextStart = 0, circuit = false, gate = Promise.resolve();
  const tickerAttempts = new Map();
  async function pacedStart(ticker,begin) {
    const current = gate.then(async()=>{
      if (signal?.aborted) throw safeError('SEC_ABORTED');
      if (circuit) throw safeError('SEC_FORBIDDEN');
      if (total>=maxFetchAttempts || requests>=maxProviderRequests || (tickerAttempts.get(ticker)??0)>=3) throw safeError('FETCH_BUDGET');
      const delay = nextStart-now();
      if (delay>0) await sleep(delay);
      if (signal?.aborted) throw safeError('SEC_ABORTED');
      if (circuit) throw safeError('SEC_FORBIDDEN');
      nextStart = now()+1000; total++; requests++;
      tickerAttempts.set(ticker,(tickerAttempts.get(ticker)??0)+1);
      // 허가만 반환하면 병렬 caller의 실제 fetch 시작이 뒤섞일 수 있어 gate 안에서 요청을 시작한다.
      const response=await begin();
      if (response.status===403) circuit=true;
      return response;
    });
    gate = current.catch(()=>{});
    return current;
  }
  async function load(category, identity) {
    assertSymbol(identity.ticker); const cik = normalizeCik(identity.cik);
    let retry = 0;
    while (true) {
      let controller,timeout;
      const abort = ()=>controller?.abort();
      let delay = 0, retryable = false, error;
      try {
        const url = category==='companyfacts' ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json` : `https://data.sec.gov/submissions/CIK${cik}.json`;
        const response = await pacedStart(identity.ticker,()=>{
          controller=new AbortController();timeout=setTimeout(()=>controller.abort(),timeoutMs);
          signal?.addEventListener('abort',abort,{once:true});
          return fetchImpl(url,{headers:{'User-Agent':userAgent,Accept:'application/json'},signal:controller.signal,redirect:'error'});
        });
        if (response.status===403) { circuit=true; await response.body?.cancel().catch(()=>{}); throw safeError('SEC_FORBIDDEN'); }
        if (response.status===429 || response.status>=500) {
          retryable=true;
          if (response.status===429) {
            const header=response.headers.get('retry-after');
            if (header && /^\d+(?:\.\d+)?$/.test(header)) delay=Math.ceil(Number(header)*1000);
            else if (header && Number.isFinite(Date.parse(header))) delay=Math.max(0,Date.parse(header)-now());
            // 무한 대기를 요구하는 응답은 다음 run/operator 판단으로 넘긴다. 요구 시간보다 일찍 재시도하지 않는다.
            if (delay>60000) { retryable=false; throw safeError('SEC_HTTP'); }
          }
          await response.body?.cancel().catch(()=>{});
          throw safeError('SEC_HTTP');
        }
        if (response.status!==200) { await response.body?.cancel().catch(()=>{}); throw safeError('SEC_HTTP'); }
        const result=await readJson(response,maxBytes,controller.signal);
        try { return validateSource(result.data,category,identity); }
        catch { throw safeError('SOURCE_INVALID'); }
      } catch (caught) {
        if (signal?.aborted) throw safeError('SEC_ABORTED');
        if (controller?.signal.aborted) { error=safeError('SEC_TIMEOUT'); retryable=true; }
        else if (caught?.code) error=safeError(caught.code);
        else { error=safeError('SEC_NETWORK'); retryable=true; }
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
      if (!retryable || circuit || (tickerAttempts.get(identity.ticker)??0)>=3 || total>=maxFetchAttempts || requests>=maxProviderRequests) throw error;
      retry++;
      await sleep(Math.max(delay,Math.min(8000,1000*2**(retry-1))+Math.floor(Math.max(0,Math.min(1,random()))*250)));
    }
  }
  return Object.freeze({companyFacts:identity=>load('companyfacts',identity),submissions:identity=>load('submissions',identity),
    stats:()=>({attempts:total,providerRequests:requests,circuitOpen:circuit})});
}
