import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecSourceFetcher } from '../scripts/sec-raw-source-fetch.mjs';
import { makeSource } from './helpers/sec-raw-automation-fixtures.js';
const identity={ticker:'O',cik:'726728'};
function fixture(responses,options={}) {
  let time=0,index=0;const starts=[],delays=[];
  const source=makeSource();
  const fetcher=createSecSourceFetcher({userAgent:'SEC synthetic test contact',now:()=>time,sleep:async ms=>{delays.push(ms);time+=ms;},random:()=>0,
    fetchImpl:async(url,request)=>{
      starts.push(time); const item=responses?.[index++];
      if (typeof item==='function') return item(url,request);
      if (item instanceof Error) throw item;
      return item??Response.json(url.includes('companyfacts')?source.companyFacts:source.submissions);
    },...options});
  return {fetcher,starts,delays};
}
test('R10B SEC loader는 Submissions + CompanyFacts, CIK와 ticker를 검증한다',async()=>{
  const f=fixture();assert.equal((await f.fetcher.submissions(identity)).tickers[0],'O');
  assert.equal((await f.fetcher.companyFacts(identity)).cik,726728);assert.deepEqual(f.starts,[0,1000]);
});
test('R10B SEC_USER_AGENT 없으면 network 시작 전 STOP',()=>assert.throws(()=>createSecSourceFetcher({fetchImpl:()=>{throw Error('network');}}),{code:'POLICY_INVALID'}));
test('R10B pacing은 병렬 ticker와 retry를 합쳐 전역 1 request/s 이하',async()=>{
  const f=fixture();await Promise.all([f.fetcher.companyFacts(identity),f.fetcher.companyFacts({...identity,ticker:'OTHER'}),f.fetcher.submissions(identity)]);
  assert.deepEqual(f.starts,[0,1000,2000]);
});
test('R10B 429 Retry-After seconds를 준수한다',async()=>{
  const f=fixture([new Response('',{status:429,headers:{'Retry-After':'5'}})]);
  await f.fetcher.companyFacts(identity);assert.deepEqual(f.starts,[0,5000]);
});
test('R10B 429 HTTP-date를 준수한다',async()=>{
  const f=fixture([new Response('',{status:429,headers:{'Retry-After':new Date(10000).toUTCString()}})]);
  await f.fetcher.companyFacts(identity);assert.equal(f.starts[1],10000);
});
test('R10B 매우 긴 Retry-After는 조기 retry 없이 다음 run으로 넘긴다',async()=>{
  const f=fixture([new Response('',{status:429,headers:{'Retry-After':'999999'}})]);
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_HTTP'});assert.equal(f.starts.length,1);
});
test('R10B 5xx는 ticker 전체 budget 3회에서 끝난다',async()=>{
  const f=fixture(Array.from({length:3},()=>new Response('',{status:503})));
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_HTTP'});assert.equal(f.starts.length,3);assert.deepEqual(f.delays,[1000,2000]);
});
test('R10B Submissions 성공 1회도 CompanyFacts retry budget에 포함한다',async()=>{
  const f=fixture([undefined,new Response('',{status:500}),new Response('',{status:500})]);
  await f.fetcher.submissions(identity);await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_HTTP'});
  assert.equal(f.fetcher.stats().attempts,3);
});
test('R10B network 원문은 버리고 bounded retry한다',async()=>{
  const f=fixture([new Error('synthetic secret body'),new Error('synthetic secret body'),new Error('synthetic secret body')]);
  await assert.rejects(f.fetcher.companyFacts(identity),error=>error.message==='SEC_NETWORK'&&!error.stack.includes('synthetic secret body'));
  assert.equal(f.starts.length,3);
});
test('R10B timeout은 abort하고 최대 3회만 시도한다',async()=>{
  const hang=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private body')),{once:true}));
  const f=fixture([hang,hang,hang],{timeoutMs:2});
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_TIMEOUT'});assert.equal(f.starts.length,3);
});
test('R10B 사용자 abort는 retry하지 않는다',async()=>{
  const controller=new AbortController();controller.abort();const f=fixture([],{signal:controller.signal});
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_ABORTED'});assert.equal(f.starts.length,0);
});
test('R10B SEC 403은 global circuit을 열고 다른 ticker fetch도 막는다',async()=>{
  const f=fixture([new Response('',{status:403})]);
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_FORBIDDEN'});
  await assert.rejects(f.fetcher.companyFacts({...identity,ticker:'OTHER'}),{code:'SEC_FORBIDDEN'});
  assert.equal(f.starts.length,1);assert.equal(f.fetcher.stats().circuitOpen,true);
});
for (const [label,response,code] of [
  ['invalid JSON',new Response('{private-invalid',{headers:{'content-type':'application/json'}}),'SOURCE_INVALID'],
  ['wrong CIK',Response.json({cik:1,facts:{}}),'SOURCE_INVALID'],
  ['html content-type',new Response('<html>',{headers:{'content-type':'text/html'}}),'SOURCE_INVALID'],
  ['body byte limit',Response.json({cik:726728,facts:{padding:'x'.repeat(500)}}),'SOURCE_TOO_LARGE'],
  ['content-length limit',new Response('{}',{headers:{'content-type':'application/json','content-length':'9999'}}),'SOURCE_TOO_LARGE'],
]) test(`R10B SEC ${label}는 단일 요청 후 fail-closed`,async()=>{
  const f=fixture([response],{maxBytes:100});await assert.rejects(f.fetcher.companyFacts(identity),{code});assert.equal(f.starts.length,1);
});
test('R10B Submissions ticker/array mismatch를 거부한다',async()=>{
  const source=makeSource();source.submissions.tickers=['MSFT'];const f=fixture([Response.json(source.submissions)]);
  await assert.rejects(f.fetcher.submissions(identity),{code:'SOURCE_INVALID'});
});
test('R10B run-level provider budget은 다른 ticker에서도 강제된다',async()=>{
  const f=fixture([],{maxProviderRequests:1});await f.fetcher.companyFacts(identity);
  await assert.rejects(f.fetcher.companyFacts({...identity,ticker:'OTHER'}),{code:'FETCH_BUDGET'});assert.equal(f.starts.length,1);
});
test('R10B run-level attempt budget은 retry 요청도 차단한다',async()=>{
  const f=fixture([new Response('',{status:500})],{maxFetchAttempts:1});
  await assert.rejects(f.fetcher.companyFacts(identity),{code:'SEC_HTTP'});assert.equal(f.starts.length,1);
});
