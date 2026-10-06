import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp,writeFile,rm,mkdir } from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProducerFixture,makeAutomationPolicy,makeSource,fixtureTarget,nextAccession,oldAccession,laterAccession,fixtureRelease,fixtureTime } from './helpers/sec-raw-automation-fixtures.js';
import { applicationIdentity,createMemoryJournalBackend,createProducerJournal } from '../scripts/sec-raw-producer-journal.mjs';
import { safeError } from '../scripts/sec-raw-automation-policy.mjs';
import { createAutomationQueueTransport } from '../scripts/sec-raw-automation-transport.mjs';
import { establishReadiness } from '../scripts/sec-raw-automation-readiness.mjs';
import { discoverAccessions,orderedCompactSource } from '../scripts/sec-raw-source-discovery.mjs';
import { runLocalProducerCli } from '../scripts/sec-raw-scheduled-producer.mjs';

function checkpoint(message) {return {accession:message.accession,sourceIdentity:message.sourceIdentity,schemaVersion:1};}
async function reserve(f) {
  const message=await f.message(),key=applicationIdentity(message);
  await f.journal.acquire({runId:'interrupted',owner:'old',target:fixtureTarget});
  await f.journal.putIntent({message,policy:f.policy,runId:'interrupted',owner:'old',runPublishes:0});
  await f.journal.release({runId:'interrupted',owner:'old'});return {message,key};
}
test('R10B 기본값 detect-only는 INTENT/Queue 발행이 없다',async()=>{
  const f=makeProducerFixture();const result=await f.run({enqueue:false,dryRun:true});
  assert.equal(result.detected,1);assert.equal(f.sends.length,0);assert.equal(Object.keys((await f.backend.load()).state.entries).length,0);
});
test('R10B explicit flag만 있고 policy enqueue 승인이 없으면 거부한다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({productionEnqueueEnabled:false})});
  await assert.rejects(f.run(),{code:'POLICY_INVALID'});assert.equal(f.sends.length,0);
});
test('R10B 동일 완료 source는 publish 0',async()=>{
  const f=makeProducerFixture(),message=await f.message();f.states.get('O').checkpoint=checkpoint(message);
  const result=await f.run();assert.equal(result.unchanged,1);assert.equal(f.sends.length,0);
});
test('R10B ACCEPTED-before-checkpoint는 재시작 후에도 publish 0',async()=>{
  const f=makeProducerFixture();assert.equal((await f.run()).queued,1);
  const restored=createProducerJournal(createMemoryJournalBackend(await f.backend.load()),{now:f.now});
  const result=await f.run({journal:restored});assert.equal(result.inFlight,1);assert.equal(f.sends.length,1);
});
test('R10B HTTP POST 전에 durable INTENT가 확인된다',async()=>{
  const f=makeProducerFixture();let calls=0;
  const result=await f.run({transport:{send:async message=>{
    const entry=await f.journal.get(applicationIdentity(message));assert.equal(entry.state,'INTENT');calls++;return {kind:'accepted'};
  }}});
  assert.equal(result.queued,1);assert.equal(calls,1);
});
test('R10B crash-before-POST INTENT는 OPERATOR_REQUIRED로 바뀌고 publish 0',async()=>{
  const f=makeProducerFixture(),{key}=await reserve(f);const result=await f.run();
  assert.equal(result.operatorRequired,1);assert.equal((await f.journal.get(key)).state,'OPERATOR_REQUIRED');assert.equal(f.sends.length,0);
});
test('R10B crash-after-POST durable 수신 기록 실패는 INTENT를 남겨 재발행하지 않는다',async()=>{
  const f=makeProducerFixture();const journal={...f.journal,markAccepted:async()=>{throw safeError('JOURNAL_IO');}};
  const first=await f.run({journal});assert.equal(first.stopped,true);assert.equal(f.sends.length,1);
  const second=await f.run();assert.equal(second.operatorRequired,1);assert.equal(f.sends.length,1);
});
test('R10B timeout/network throw after POST는 AMBIGUOUS이고 즉시/다음 run retry 0',async()=>{
  const f=makeProducerFixture();let calls=0;
  const transport={send:async()=>{calls++;throw new Error('private-payload');}};
  const first=await f.run({transport});assert.equal(first.ambiguous,1);assert.equal(calls,1);
  const second=await f.run({transport});assert.equal(second.ambiguous,1);assert.equal(calls,1);
});
test('R10B exact 완료 checkpoint를 관측하면 ACCEPTED journal만 reconcile한다',async()=>{
  const f=makeProducerFixture();await f.run();const message=f.sends[0];f.states.get('O').checkpoint=checkpoint(message);
  await f.run();assert.equal((await f.journal.get(applicationIdentity(message))).state,'COMPLETED_RECONCILED');assert.equal(f.sends.length,1);
});
test('R10B pending review 동일 source publish 0, 변경 source는 한 번만 후보가 된다',async()=>{
  const f=makeProducerFixture();await f.run();const message=f.sends[0];
  const reviewReader=async()=>({...checkpoint(message),status:'pending_review'});
  const result=await f.run({reviewReader});assert.equal(result.reviewBlocked,1);assert.equal(f.sends.length,1);
  f.sources.set('O',makeSource('O',{cash:11}));assert.equal((await f.run({reviewReader})).queued,1);
  await f.run({reviewReader});assert.equal(f.sends.length,2);
});
test('R10B 처리 확인된 review 뒤의 새 accession은 영구 정체 없이 다음 run에서 후보가 된다',async()=>{
  const f=makeProducerFixture();await f.run();const message=f.sends[0];
  const reviewReader=async()=>({...checkpoint(message),status:'pending_review'});await f.run({reviewReader});
  f.sources.set('O',makeSource('O',{accessions:[laterAccession,nextAccession,oldAccession],indexed:[laterAccession,nextAccession]}));
  assert.equal((await f.run({reviewReader})).queued,1);assert.equal(f.sends[1].accession,laterAccession);
});
test('R10B runtime pending만 있으면 source 완료를 추측하지 않고 in-flight 억제한다',async()=>{
  const f=makeProducerFixture();await f.run();f.states.get('O').runtime.raw_status='pending';
  const result=await f.run();assert.equal(result.inFlight,1);assert.equal(result.reviewBlocked,0);assert.equal(f.sends.length,1);
});
test('R10B same-accession correction은 다른 identity로 한 번만 발행한다',async()=>{
  const f=makeProducerFixture(),original=await f.message();f.states.get('O').checkpoint=checkpoint(original);
  f.sources.set('O',makeSource('O',{cash:11}));assert.equal((await f.run()).queued,1);
  assert.notEqual(f.sends[0].sourceIdentity,original.sourceIdentity);assert.equal(f.sends[0].accession,original.accession);
  await f.run();assert.equal(f.sends.length,1);
});
test('R10B 두 missed accession은 oldest 먼저 하나씩; Queue ordering에 의존하지 않는다',async()=>{
  const f=makeProducerFixture();f.sources.set('O',makeSource('O',{accessions:[laterAccession,nextAccession,oldAccession],indexed:[laterAccession,nextAccession]}));
  const first=await f.run();assert.equal(first.queued,1);assert.equal(f.sends[0].accession,nextAccession);
  assert.equal((await f.run()).inFlight,1);assert.equal(f.sends.length,1);
  f.states.get('O').checkpoint=checkpoint(f.sends[0]);assert.equal((await f.run()).queued,1);
  assert.equal(f.sends[1].accession,laterAccession);assert.equal(f.sends.length,2);
});
test('R10B filed date 같으면 accession 정렬이 catch-up 순서를 결정한다',()=>{
  const source=makeSource('O',{accessions:[laterAccession,nextAccession,oldAccession],indexed:[laterAccession,nextAccession]});
  source.submissions.filings.recent.filingDate[0]='2026-04-01';
  const candidates=discoverAccessions({...source,approved:{ticker:'O',cik:'726728'},allowedForms:['10-Q'],historical:{accession:oldAccession}});
  assert.deepEqual(candidates.map(row=>row.accession),[nextAccession,laterAccession]);
});
test('R10B unsupported forms는 후보가 아니며 /A amendment는 지원한다',()=>{
  const source=makeSource();source.submissions.filings.recent.form[0]='8-K';
  const options={...source,approved:{ticker:'O',cik:'726728'},allowedForms:['10-Q/A'],historical:{accession:oldAccession}};
  assert.equal(discoverAccessions(options).length,0);source.submissions.filings.recent.form[0]='10-Q/A';assert.equal(discoverAccessions(options).length,1);
});
test('R10B source-not-indexed는 이전 source를 재발행하지 않고 지연 횟수를 제한한다',async()=>{
  const f=makeProducerFixture();f.sources.set('O',makeSource('O',{indexed:[]}));
  assert.equal((await f.run()).sourceNotIndexed,1);await f.run();
  assert.equal((await f.journal.delayed('O',nextAccession)).attempts,1);
  f.advance(300000);await f.run();f.advance(600000);await f.run();
  assert.equal((await f.journal.delayed('O',nextAccession)).status,'OPERATOR_REQUIRED');
  assert.equal(f.sends.length,0);assert.equal(f.states.get('O').runtime.raw_status,'ready');
});
test('R10B recent archive 범위 밖 누락은 건너뛰지 않고 fail-closed',async()=>{
  const f=makeProducerFixture();const source=makeSource('O',{accessions:[nextAccession],indexed:[oldAccession,nextAccession]});
  source.submissions.filings.files=[{name:'synthetic-archive.json'}];f.sources.set('O',source);
  const result=await f.run();assert.equal(result.failed,1);assert.ok(result.errorCategories.includes('DISCOVERY_WINDOW_INCOMPLETE'));assert.equal(f.sends.length,0);
});
test('R10B 첫 ticker fetch 실패는 다음 ticker를 막지 않는다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});
  const result=await f.run({sourceLoader:async approved=>{
    if (approved.ticker==='O') throw safeError('SOURCE_INVALID');return f.sources.get(approved.ticker);
  }});
  assert.equal(result.failed,1);assert.equal(result.checked,2);assert.equal(result.queued,1);assert.equal(f.sends[0].ticker,'MSFT');
});
test('R10B core의 Node source fetch도 fake fetch/clock으로만 연결하고 요청 2회를 pacing한다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({secFetchEnabled:true})}),starts=[];
  const source=f.sources.get('O');
  const result=await f.run({sourceLoader:undefined,userAgent:'SEC synthetic test contact',sleep:async ms=>f.advance(ms),random:()=>0,
    fetchImpl:async url=>{starts.push(f.now());return Response.json(url.includes('companyfacts')?source.companyFacts:source.submissions);}});
  assert.equal(result.queued,1);assert.equal(starts.length,2);assert.equal(starts[1]-starts[0],1000);
});
test('R10B core의 global fetch budget은 다음 ticker의 SEC 호출을 차단한다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({secFetchEnabled:true,maxProviderRequests:2,
    scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});let calls=0;
  const source=f.sources.get('O');
  const result=await f.run({sourceLoader:undefined,userAgent:'SEC synthetic test contact',sleep:async ms=>f.advance(ms),random:()=>0,
    fetchImpl:async url=>{calls++;return Response.json(url.includes('companyfacts')?source.companyFacts:source.submissions);}});
  assert.equal(result.queued,1);assert.equal(result.stopped,true);assert.ok(result.errorCategories.includes('FETCH_BUDGET'));assert.equal(calls,2);
});
test('R10B global SEC 403은 다음 ticker를 실행하지 않는다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});let calls=0;
  const result=await f.run({sourceLoader:async()=>{calls++;throw safeError('SEC_FORBIDDEN');}});
  assert.equal(result.stopped,true);assert.equal(calls,1);assert.equal(f.sends.length,0);
});
test('R10B 공통 D1 read 실패는 후속 provider 조회를 진행하지 않는다',async()=>{
  const f=makeProducerFixture();let sourceCalls=0;
  const result=await f.run({reader:{...f.reader,ticker:async()=>{throw safeError('D1_READ');}},
    sourceLoader:async()=>{sourceCalls++;return f.sources.get('O');}});
  assert.equal(result.stopped,true);assert.equal(sourceCalls,0);
});
test('R10B publish run budget을 넘긴 ticker는 발행하지 않는다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({maxPublishesPerRun:1,scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});
  const result=await f.run();assert.equal(result.queued,1);assert.equal(result.budgetSkipped,1);assert.equal(f.sends.length,1);
  assert.equal(f.states.get('MSFT').checkpoint,null);
});
test('R10B publish daily budget은 독립된 다음 run에도 유지된다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({maxPublishesPerRun:1,maxPublishesPerDay:1,
    scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});await f.run();
  const result=await f.run();assert.equal(result.inFlight,1);assert.equal(result.budgetSkipped,1);assert.equal(f.sends.length,1);
});
test('R10B 100 ticker/100 messages는 readiness 1회 + ticker별 bounded read뿐이다',async()=>{
  const scope=Array.from({length:100},(_,i)=>({ticker:`S${i}`,cik:String(700000+i)}));
  const f=makeProducerFixture({policy:makeAutomationPolicy({scope})});const result=await f.run();
  assert.equal(result.checked,100);assert.equal(result.queued,100);assert.equal(f.sends.length,100);
  assert.equal(f.queries.filter(row=>row==='run-readiness').length,1);assert.equal(f.queries.filter(row=>row==='indexed-ticker').length,100);
  assert.ok(f.sends.every(message=>!('companyFacts' in message)));
});
test('R10B 원문 fact 배열 순서만 바뀌면 compact identity는 변하지 않는다',async()=>{
  const f=makeProducerFixture(),source=f.sources.get('O');
  const rows=source.companyFacts.facts['us-gaap'].Assets.units.USD;rows.push({...rows[0],end:'2024-12-31',val:100});
  const before=await f.message();rows.reverse();const after=await f.message();assert.equal(before.sourceIdentity,after.sourceIdentity);
  assert.equal(orderedCompactSource(source.companyFacts,nextAccession).facts['us-gaap'].Assets.units.USD.length,2);
});
test('R10B summary/error/journal에 secret/raw/email/연락처는 남지 않는다',async()=>{
  const f=makeProducerFixture();const marker='SYNTHETIC_PRIVATE_DO_NOT_LOG';
  const result=await f.run({sourceLoader:async()=>{throw Error(JSON.stringify({token:marker,email:`${marker}@invalid.example`,facts:marker,Authorization:marker}));}});
  const serialized=JSON.stringify({result,state:await f.backend.load()});
  assert.ok(!serialized.includes(marker));assert.ok(!serialized.includes('@invalid.example'));assert.deepEqual(result.errorCategories,['INTERNAL_SAFE']);
});
test('R10B CLI는 live/credential/enqueue 옵션을 받지 않는다',async()=>{
  await assert.rejects(runLocalProducerCli(['--enqueue']),{code:'POLICY_INVALID'});
  await assert.rejects(runLocalProducerCli(['--fixture','package.json']),{code:'POLICY_INVALID'});
});
test('R10B ignored 합성 fixture CLI는 detect-only로 성공하며 remote transport가 없다',async()=>{
  const parent=resolve('backups/r10b');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'cli-fixture-'));
  try {
    const release=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const f=makeProducerFixture({policy:makeAutomationPolicy({release,validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()})});
    const config={policy:f.policy,identity:{uuid:fixtureTarget.databaseId,name:fixtureTarget.databaseName,accountId:fixtureTarget.accountId},
      readiness:f.readiness,states:Object.fromEntries(f.states),sources:Object.fromEntries(f.sources),journalFile:'cli.fixture.json'};
    const file=join(directory,'input.fixture.json');await writeFile(file,JSON.stringify(config));
    const result=await runLocalProducerCli(['--fixture',file]);assert.equal(result.detected,1);assert.equal(result.queued,0);
  } finally {assert.ok(resolve(directory).startsWith(parent+sep));await rm(directory,{recursive:true,force:true});}
});
test('R10B consumer/historical/lease/fence/review/UI/migration source는 HEAD와 byte-identical이다',()=>{
  const paths=['worker/src/sec-raw-queue.js','worker/src/sec-raw-message.js','worker/src/sec-standard-raw-incremental.js',
    'worker/src/sec-standard-raw-runtime.js','worker/src/sec-standard-raw-store.js','scripts/sec-raw-historical-import.mjs',
    'scripts/sec-raw-queue-transport.mjs','scripts/sec-raw-discovery-runner.mjs','app.js','worker/src/company-classification.js'];
  for (const path of paths) assert.equal(readFileSync(path,'utf8'),execFileSync('git',['show',`HEAD:${path}`],{encoding:'utf8',maxBuffer:4*1024*1024}));
});

for (const [label,response,kind,category] of [
  ['accepted',()=>Response.json({success:true,result:{}}),'accepted','ACCEPTED'],
  ['401',()=>new Response('',{status:401}),'rejected','QUEUE_AUTH'],
  ['403',()=>new Response('',{status:403}),'rejected','QUEUE_AUTH'],
  ['404',()=>new Response('',{status:404}),'rejected','QUEUE_TARGET'],
  ['429',()=>new Response('',{status:429}),'rejected','QUEUE_REJECTED'],
  ['5xx',()=>new Response('',{status:503}),'ambiguous','QUEUE_AMBIGUOUS'],
  ['invalid success',()=>Response.json({success:false}),'ambiguous','QUEUE_AMBIGUOUS'],
  ['invalid JSON',()=>new Response('synthetic raw body'),'ambiguous','QUEUE_AMBIGUOUS'],
  ['network',()=>{throw Error('private-header');},'ambiguous','QUEUE_AMBIGUOUS'],
]) test(`R10B Queue fake transport ${label}: 단일 POST, 안전한 결과 범주`,async()=>{
  const f=makeProducerFixture(),runId='transport-test',receipt=await establishReadiness({policy:f.policy,reader:f.reader,runId,now:f.now});
  let calls=0;const transport=createAutomationQueueTransport({credential:'synthetic-only',now:f.now,fetchImpl:async(url,request)=>{
    calls++;assert.ok(url.includes(fixtureTarget.queueId));assert.equal(request.method,'POST');
    const body=JSON.parse(request.body);assert.deepEqual(Object.keys(body).sort(),['body','content_type']);
    assert.equal(body.content_type,'json');assert.equal(body.body.ticker,'O');return response();
  }});
  const result=await transport.send(await f.message(),{policy:f.policy,receipt,runId,enqueue:true});
  assert.equal(result.kind,kind);assert.equal(result.category,category);assert.equal(calls,1);
  assert.ok(!JSON.stringify(result).includes('private-header'));
});
test('R10B Queue timeout은 ambiguous, transport 자체 retry 0',async()=>{
  const f=makeProducerFixture(),runId='timeout',receipt=await establishReadiness({policy:f.policy,reader:f.reader,runId,now:f.now});let calls=0;
  const transport=createAutomationQueueTransport({credential:'synthetic-only',now:f.now,timeoutMs:2,
    fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private')),{once:true}));}});
  assert.equal((await transport.send(await f.message(),{policy:f.policy,receipt,runId,enqueue:true})).kind,'ambiguous');assert.equal(calls,1);
});
test('R10B Queue auth/target 실패는 전체 producer를 STOP한다',async()=>{
  const f=makeProducerFixture({policy:makeAutomationPolicy({scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}]})});let calls=0;
  const result=await f.run({transport:{send:async()=>{calls++;return {kind:'rejected',category:'QUEUE_AUTH'};}}});
  assert.equal(result.stopped,true);assert.equal(calls,1);
});
test('R10B forged receipt는 Queue POST 이전에 거부한다',async()=>{
  const f=makeProducerFixture();let calls=0;
  const transport=createAutomationQueueTransport({credential:'synthetic-only',now:()=>fixtureTime,fetchImpl:()=>{calls++;throw Error();}});
  await assert.rejects(transport.send(await f.message(),{policy:f.policy,receipt:{},runId:'forged',enqueue:true}),{code:'RECEIPT_INVALID'});
  assert.equal(calls,0);
});
