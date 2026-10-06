import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildCompactSecRawMessage,selectCompactRawFacts } from '../scripts/sec-raw-compact-producer.mjs';
import { buildDiscoveredMessage } from '../scripts/sec-raw-source-discovery.mjs';
import { classifyCompactCheckpoint,compactSemanticsExact,computeLegacyCompactSourceIdentityV1,
  computeCanonicalCompactSourceIdentityV2,consumerApplicationIdentityV1 } from '../scripts/sec-raw-producer-identity.mjs';
import { applicationIdentity,producerJournalIdentityV1,JOURNAL_APPLICATION_IDENTITY_VERSION } from '../scripts/sec-raw-producer-journal.mjs';
import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';
import { consumeCompactSecRaw } from '../worker/src/sec-raw-queue.js';
import { createRawRuntimeDatabase } from './helpers/sec-standard-raw-runtime-db.js';
import { makeProducerFixture,makeAutomationPolicy,makeSource,fixtureRelease,fixtureTarget,fixtureTime } from './helpers/sec-raw-automation-fixtures.js';
import { policyManifestHash,validateAutomationPolicy,producerIdentityAlgorithmVersion } from '../scripts/sec-raw-automation-policy.mjs';
import { establishReadiness } from '../scripts/sec-raw-automation-readiness.mjs';
import { readIdentityCacheFixtures,identityMessages,cacheProducerFixture,expectedAaplLegacy,expectedAaplCanonical } from './helpers/sec-raw-identity-fixtures.js';
import { runIdentityCompatibilityAudit } from '../scripts/sec-raw-identity-audit.mjs';

// 실제 원문은 ignored cache에서 메모리로만 읽는다. assertion에는 raw 값/records를 출력하지 않는다.
let items;
const item=ticker=>(items??=readIdentityCacheFixtures()).find(row=>row.ticker===ticker);
const cp=message=>({accession:message.accession,sourceIdentity:message.sourceIdentity,schemaVersion:1});
const input=row=>({...row,enqueuedAt:'2026-10-06T00:00:00Z'});

test('R10C2 AAPL V1 exact 재현',async()=>assert.equal(await computeLegacyCompactSourceIdentityV1(input(item('AAPL'))),expectedAaplLegacy));
test('R10C2 AAPL V2 exact 재현',async()=>assert.equal(await computeCanonicalCompactSourceIdentityV2(input(item('AAPL'))),expectedAaplCanonical));
test('R10C2 AAPL compact field/records/출처 semantic exact',async()=>{
  const {legacy,canonicalMessage}=await identityMessages(item('AAPL'));
  assert.equal(await compactSemanticsExact(legacy,canonicalMessage),true);
});
test('R10C2 AAPL 운영 V1 checkpoint는 UNCHANGED_COMPAT',async()=>{
  const row=item('AAPL'),{canonicalMessage}=await identityMessages(row);
  assert.equal((await classifyCompactCheckpoint({...row,message:canonicalMessage})).decision,'UNCHANGED_COMPAT');
});
test('R10C2 AAPL compat에는 publish/INTENT/completion 생성 0',async()=>{
  const row=item('AAPL'),f=await cacheProducerFixture(row,row.checkpoint),before=JSON.stringify(f.states.get('AAPL'));
  const result=await f.run();assert.equal(result.unchangedCompat,1);assert.equal(result.detected,0);assert.equal(result.unchanged,1);
  assert.equal(f.sends.length,0);assert.equal(Object.keys((await f.backend.load()).state.entries).length,0);
  assert.equal(JSON.stringify(f.states.get('AAPL')),before);
});
test('R10C2 MSFT 운영 checkpoint는 일반 UNCHANGED',async()=>{
  const row=item('MSFT'),{legacy,canonicalMessage}=await identityMessages(row);
  assert.equal(legacy.sourceIdentity,row.checkpoint.sourceIdentity);assert.equal(legacy.sourceIdentity,canonicalMessage.sourceIdentity);
  assert.equal(await compactSemanticsExact(legacy,canonicalMessage),true);
  const f=await cacheProducerFixture(row,row.checkpoint),r=await f.run();
  assert.equal(r.unchanged,1);assert.equal(r.unchangedCompat,0);assert.equal(r.identityDecisions[0].decision,'UNCHANGED');assert.equal(f.sends.length,0);
});
test('R10C2 승인 10종목 offline semantic audit: 2 동일/8 ordering-only',async()=>{
  const audit=await runIdentityCompatibilityAudit();assert.equal(audit.rows.length,10);
  assert.equal(audit.sameIdentity,2);assert.equal(audit.normalizedOnlyDifferences,8);assert.equal(audit.actualSemanticDifferences,0);
});
test('R10C2 fact shuffle 12 permutations: V2 exact stable/V1 order-sensitive',async()=>{
  const row=item('AAPL'),facts=selectCompactRawFacts(row.companyFacts.facts,row.accession),v1=new Set();
  for(let i=0;i<12;i++){
    const changed=structuredClone(facts);let seed=(i+1)*1234567;
    for(const tags of Object.values(changed))for(const tag of Object.values(tags))for(const rows of Object.values(tag.units)){
      for(let index=rows.length-1;index>0;index--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        const other=seed%(index+1);[rows[index],rows[other]]=[rows[other],rows[index]];}
    }
    const args={...input(row),companyFacts:{cik:Number(row.cik),facts:changed}};
    assert.equal(await computeCanonicalCompactSourceIdentityV2(args),expectedAaplCanonical);
    v1.add(await computeLegacyCompactSourceIdentityV1(args));
  }
  assert.ok(v1.size>=10,'실제 서로 다른 10개 이상 permutation 필요');
});
test('R10C2 legacy producer 호출/알고리즘은 byte-identical 유지',()=>{
  const file='scripts/sec-raw-compact-producer.mjs';
  assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}));
});

for(const field of ['val','filed','fp'])test(`R10C2 true correction ${field}는 compat로 숨기지 않음`,async()=>{
  const original=item('AAPL'),facts=selectCompactRawFacts(original.companyFacts.facts,original.accession);
  const fact=Object.values(facts['us-gaap']).flatMap(tag=>Object.values(tag.units)).flat()[0];
  if(field==='val')fact.val+=1;if(field==='filed')fact.filed='2026-08-01';if(field==='fp')fact.fp=fact.fp==='FY'?'Q1':'FY';
  const row={...original,companyFacts:{cik:320193,facts}}, {canonicalMessage}=await identityMessages(row);
  const verdict=await classifyCompactCheckpoint({...row,message:canonicalMessage});assert.equal(verdict.decision,'CORRECTION_CANDIDATE');
  const f=await cacheProducerFixture(row,original.checkpoint),r=await f.run({enqueue:false,dryRun:true});
  assert.equal(r.detected,1);assert.equal(r.unchangedCompat,0);assert.equal(r.identityDecisions[0].decision,'CORRECTION_CANDIDATE');
  assert.equal(f.sends.length,0);
});
test('R10C2 legacy hash가 일치해도 canonical semantic 변경은 bridge 금지',async()=>{
  const row=item('AAPL'),facts=selectCompactRawFacts(row.companyFacts.facts,row.accession);
  facts['us-gaap'].Assets.units.USD[0].val+=1;
  const changed=await buildDiscoveredMessage({approved:row,candidate:row,companyFacts:{cik:320193,facts},financialPeriods:row.financialPeriods});
  const r=await classifyCompactCheckpoint({...row,message:changed});assert.equal(r.semanticEquality,false);assert.equal(r.decision,'CORRECTION_CANDIDATE');
});
test('R10C2 새 accession은 NEW_SOURCE이며 legacy bridge로 skip 불가',async()=>{
  const f=makeProducerFixture();f.sources.set('O',makeSource('O',{indexed:['0000726728-26-000002','0000726728-26-000001']}));
  const prior=await f.message('O','0000726728-26-000001');f.states.get('O').checkpoint=cp(prior);
  const r=await f.run({enqueue:false,dryRun:true});assert.equal(r.detected,1);assert.equal(r.identityDecisions.at(-1).decision,'NEW_SOURCE');
});
test('R10C2 source-not-indexed 지연/완료 오인 방지 유지',async()=>{
  const f=makeProducerFixture();f.sources.set('O',makeSource('O',{indexed:[]}));
  const r=await f.run({enqueue:false,dryRun:true});assert.equal(r.sourceNotIndexed,1);assert.equal(r.detected,0);assert.equal(f.sends.length,0);
});
for(const state of ['ACCEPTED','AMBIGUOUS'])test(`R10C2 legacy ${state} unresolved 억제는 bridge보다 우선`,async()=>{
  const row=item('AAPL'),{legacy}=await identityMessages(row),f=await cacheProducerFixture(row,row.checkpoint);
  await f.journal.acquire({runId:'old-run',owner:'old-owner',target:fixtureTarget});
  const entry=await f.journal.putIntent({message:legacy,policy:f.policy,runId:'old-run',owner:'old-owner',runPublishes:0});
  if(state==='ACCEPTED')await f.journal.markAccepted(entry.entry.applicationIdentity);else await f.journal.markAmbiguous(entry.entry.applicationIdentity);
  await f.journal.release({runId:'old-run',owner:'old-owner'});
  // 완료 근거를 주지 않은 경우에만 unresolved 상태를 유지하는지 확인한다.
  f.states.get('AAPL').checkpoint=null;
  const r=await f.run();assert.equal(state==='ACCEPTED'?r.inFlight:r.ambiguous,1);assert.equal(f.sends.length,0);
  assert.equal(Object.keys((await f.backend.load()).state.entries).length,1);
});
test('R10C2 legacy REVIEW_BLOCKED 별칭은 V2 INTENT를 만들지 않음',async()=>{
  const row=item('AAPL'),{legacy}=await identityMessages(row),f=await cacheProducerFixture(row,null);
  await f.journal.acquire({runId:'old-run',owner:'old-owner',target:fixtureTarget});
  const entry=await f.journal.putIntent({message:legacy,policy:f.policy,runId:'old-run',owner:'old-owner',runPublishes:0});
  await f.journal.markAccepted(entry.entry.applicationIdentity);await f.journal.release({runId:'old-run',owner:'old-owner'});
  // historical anchor 뒤의 후보를 유지하고, review 증거는 legacy source hash 그대로 제공한다.
  f.readiness[0].historical_accession='0000320193-25-000079';
  const source=f.sources.get('AAPL'),recent=source.submissions.filings.recent;
  recent.accessionNumber.push(f.readiness[0].historical_accession);recent.filingDate.push('2025-07-31');recent.form.push('10-Q');
  const r=await f.run({reviewReader:async()=>({...cp(legacy),status:'pending_review'})});
  assert.equal(r.reviewBlocked,1);assert.equal(f.sends.length,0);assert.equal(Object.keys((await f.backend.load()).state.entries).length,1);
  assert.equal((await f.journal.get(entry.entry.applicationIdentity)).state,'REVIEW_BLOCKED');
});
test('R10C2 wire applicationIdentity와 journal key는 호환된 별도 namespace',async()=>{
  const {legacy,canonicalMessage}=await identityMessages(item('AAPL'));
  for(const message of [legacy,canonicalMessage]){
    assert.equal(message.idempotencyKey,consumerApplicationIdentityV1(message.sourceIdentity));
    assert.equal(applicationIdentity(message),producerJournalIdentityV1(message));assert.match(applicationIdentity(message),/^[a-f0-9]{64}$/);
    assert.notEqual(applicationIdentity(message),message.idempotencyKey);await validateCompactSecRawMessage(message);
  }
  assert.notEqual(applicationIdentity(legacy),applicationIdentity(canonicalMessage));assert.equal(JOURNAL_APPLICATION_IDENTITY_VERSION,1);
});
test('R10C2 V2 message는 현재 consumer validator 통과',async()=>{
  const {canonicalMessage}=await identityMessages(item('AAPL'));const validated=await validateCompactSecRawMessage(canonicalMessage);
  assert.equal(validated.records.length,67);assert.equal(validated.message.version,1);
});

async function consume(ctx,message){
  let ack=0,retry=0;const result=await consumeCompactSecRaw({body:message,ack(){ack++;},retry(){retry++;}},
    {DB:ctx.DB,SEC_STANDARD_RAW_QUEUE_ENABLED:'true'},{queueOnly:true});
  assert.equal(ack,1);assert.equal(retry,0);return result;
}
function disposable(){const ctx=createRawRuntimeDatabase();ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('AAPL','합성 로컬 검증'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source) VALUES ('AAPL','annual','2025-12-31',42,'TEST')");return ctx;}
test('R10C2 V2 initial processing는 disposable DB 정상 완료',async()=>{
  const ctx=disposable();try{const {canonicalMessage}=await identityMessages(item('AAPL'));
    assert.equal((await consume(ctx,canonicalMessage)).status,'ready');
    assert.equal(ctx.sqlite.prepare("SELECT source_identity FROM sec_raw_payload_checkpoint WHERE channel='compact'").get().source_identity,canonicalMessage.sourceIdentity);
  }finally{ctx.sqlite.close();}
});
test('R10C2 V2 duplicate는 logical write 0/정상 no-op',async()=>{
  const ctx=disposable();try{const {canonicalMessage}=await identityMessages(item('AAPL'));await consume(ctx,canonicalMessage);ctx.reset();
    assert.equal((await consume(ctx,canonicalMessage)).status,'unchanged');assert.equal(ctx.batchCalls,0);
    assert.equal(ctx.stats.reduce((n,row)=>n+row.logicalChanges,0),0);
  }finally{ctx.sqlite.close();}
});
test('R10C2 V1 checkpoint는 진짜 새 source 완료 때 V2로 자연 rollover',async()=>{
  const ctx=disposable();try{
    const row=item('AAPL'),{legacy}=await identityMessages(row);assert.equal((await consume(ctx,legacy)).status,'ready');
    const facts=selectCompactRawFacts(row.companyFacts.facts,row.accession),accession='0000320193-26-000021';
    for(const tags of Object.values(facts))for(const tag of Object.values(tags))for(const entries of Object.values(tag.units))
      for(const entry of entries){entry.accn=accession;entry.filed='2026-08-01';}
    const next=await buildDiscoveredMessage({approved:row,candidate:{accession},companyFacts:{cik:320193,facts},financialPeriods:row.financialPeriods});
    assert.equal((await classifyCompactCheckpoint({checkpoint:cp(legacy),message:next})).decision,'NEW_SOURCE');
    assert.equal((await consume(ctx,next)).status,'ready');
    const after=ctx.sqlite.prepare("SELECT * FROM sec_raw_payload_checkpoint WHERE channel='compact'").get();
    assert.equal(after.accession,accession);assert.equal(after.source_identity,next.sourceIdentity);
    assert.equal(ctx.sqlite.prepare('SELECT revenue FROM financial_metrics').get().revenue,42);
    ctx.reset();assert.equal((await consume(ctx,next)).status,'unchanged');assert.equal(ctx.batchCalls,0);
  }finally{ctx.sqlite.close();}
});
test('R10C2 migration/consumer/검증기/schema 변경 없음',()=>{
  for(const file of ['worker/src/sec-raw-message.js','worker/src/sec-raw-queue.js','worker/src/sec-raw-consumer-entry.js',
    ...readdirSync('worker/migrations').filter(n=>n.endsWith('.sql')).map(n=>'worker/migrations/'+n)])
    assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}));
  assert.equal(readdirSync('worker/migrations').filter(n=>n.endsWith('.sql')).length,22);
});
test('R10C2 compat는 journal V2 fake completion을 만들지 않음',async()=>{
  const row=item('AAPL'),f=await cacheProducerFixture(row,row.checkpoint);await f.run();
  const state=(await f.backend.load()).state;assert.equal(Object.keys(state.entries).length,0);assert.equal(Object.keys(state.days).length,0);
});
test('R10C2 summary/journal에 raw/credential/error 원문 노출 없음',async()=>{
  const row=item('AAPL'),f=await cacheProducerFixture(row,row.checkpoint),r=await f.run();
  assert.doesNotMatch(JSON.stringify({r,state:(await f.backend.load()).state}),/"(?:facts|val|metricValue|sourceRefs|credential|Authorization)"/);
  const broken=await f.run({sourceLoader:async()=>{throw new Error('synthetic-private-body-marker');}});
  assert.ok(!JSON.stringify(broken).includes('synthetic-private-body-marker'));
});
test('R10C2 version 명시 policy 및 기존 R10B policy는 모두 V2로 고정',async()=>{
  const explicit=makeAutomationPolicy(),old={...explicit};delete old.identityAlgorithmVersion;old.policyManifestHash=policyManifestHash(old);
  const validate=p=>validateAutomationPolicy(p,{release:fixtureRelease,target:fixtureTarget,now:fixtureTime});
  assert.equal(producerIdentityAlgorithmVersion(validate(explicit)),2);assert.equal(producerIdentityAlgorithmVersion(validate(old)),2);
  assert.ok(!Object.hasOwn(old,'identityAlgorithmVersion'),'기존 manifest를 rewrite하지 않는다');
  for(const version of [1,3,null])assert.throws(()=>validate(makeAutomationPolicy({identityAlgorithmVersion:version})),{code:'POLICY_INVALID'});
  const f=makeProducerFixture(),receipt=await establishReadiness({policy:f.policy,reader:f.reader,runId:'identity-policy',now:f.now});
  assert.equal(receipt.identityAlgorithmVersion,2);assert.equal(f.journal.identityAlgorithmVersion,1);
});
test('R10C2 schema/accession mismatch는 legacy hash 일치만으로 skip 불가',async()=>{
  const row=item('AAPL'),{canonicalMessage}=await identityMessages(row);
  const changed={...row.checkpoint,schemaVersion:2};
  assert.equal((await classifyCompactCheckpoint({...row,checkpoint:changed,message:canonicalMessage})).decision,'CORRECTION_CANDIDATE');
});
