import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,basename } from 'node:path';
import { createProducerJournal,createLocalFixtureJournalBackend,createMemoryJournalBackend,applicationIdentity } from '../scripts/sec-raw-producer-journal.mjs';
import { makeProducerFixture,fixtureTarget,fixtureTime } from './helpers/sec-raw-automation-fixtures.js';

async function prepare(f,journal=f.journal) {
  await journal.acquire({runId:'test-run',owner:'test-owner',target:fixtureTarget});
  const message=await f.message();
  const input={message,policy:f.policy,runId:'test-run',owner:'test-owner',runPublishes:0};
  await journal.putIntent(input);return {message,input,key:applicationIdentity(message)};
}
/** 이 테스트가 만든 절대 임시 경로만 정리한다. tmp root나 사용자 자료를 삭제 대상으로 사용하지 않는다. */
async function removeFixtureDirectory(directory) {
  const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));
  assert.match(basename(target),/^sec-producer-(?:fixture|cas)-[A-Za-z0-9]+$/);
  await rm(target,{recursive:true,force:true});
}
test('R10B journal CAS conflict는 상태를 덮어쓰지 않는다',async()=>{
  const backend=createMemoryJournalBackend(),snapshot=await backend.load();
  assert.equal(await backend.compareAndSwap(snapshot.revision,snapshot.state),true);
  assert.equal(await backend.compareAndSwap(snapshot.revision,snapshot.state),false);
});
test('R10B bounded CAS 실패 시 STOP',async()=>{
  const backend=createMemoryJournalBackend();let attempts=0;
  const journal=createProducerJournal({load:backend.load,compareAndSwap:async()=>{attempts++;return false;}},{now:()=>fixtureTime});
  await assert.rejects(journal.acquire({runId:'run',owner:'owner',target:fixtureTarget}),{code:'JOURNAL_CAS'});assert.equal(attempts,3);
});
test('R10B 동일 journal에서 두 writer는 동시에 lock을 갖지 못한다',async()=>{
  const backend=createMemoryJournalBackend(),a=createProducerJournal(backend),b=createProducerJournal(backend);
  const results=await Promise.allSettled([a.acquire({runId:'one',owner:'a',target:fixtureTarget}),b.acquire({runId:'two',owner:'b',target:fixtureTarget})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.code,'LOCK_BUSY');
});
test('R10B stale run lock은 자동 삭제/탈취하지 않는다',async()=>{
  const f=makeProducerFixture();await f.journal.acquire({runId:'old',owner:'old-owner',target:fixtureTarget,ttlMs:1000});f.advance(1000);
  await assert.rejects(f.journal.acquire({runId:'new',owner:'new-owner',target:fixtureTarget}),{code:'LOCK_STALE'});
  await assert.rejects(f.journal.clearStale({runId:'old',owner:'old-owner'}),{code:'OPERATOR_REQUIRED'});
  await f.journal.clearStale({runId:'old',owner:'old-owner',operatorApproved:true});
  await f.journal.acquire({runId:'new',owner:'new-owner',target:fixtureTarget});
});
test('R10B lock 다른 owner의 INTENT 예약은 거부한다',async()=>{
  const f=makeProducerFixture(),{input}=await prepare(f);
  await assert.rejects(f.journal.putIntent({...input,owner:'wrong'}),{code:'LOCK_BUSY'});
});
test('R10B durable INTENT는 local 파일 재시작 후에도 유지된다',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sec-producer-fixture-'));
  try {
    const file=join(directory,'journal.fixture.json'),f=makeProducerFixture(),journal=createProducerJournal(createLocalFixtureJournalBackend(file),{now:f.now});
    const {key}=await prepare(f,journal);
    const restored=createProducerJournal(createLocalFixtureJournalBackend(file),{now:f.now});
    assert.equal((await restored.get(key)).state,'INTENT');
    await restored.markAccepted(key);assert.equal((await journal.get(key)).state,'ACCEPTED');
    assert.ok(!(await readFile(file,'utf8')).includes('financialPeriods'));
  } finally {await removeFixtureDirectory(directory);}
});
test('R10B local durable backend도 revision CAS를 강제한다',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sec-producer-cas-'));
  try {
    const file=join(directory,'journal.fixture.json'),a=createLocalFixtureJournalBackend(file),b=createLocalFixtureJournalBackend(file),snapshot=await a.load();
    assert.equal(await a.compareAndSwap(null,snapshot.state),true);assert.equal(await b.compareAndSwap(null,snapshot.state),false);
  } finally {await removeFixtureDirectory(directory);}
});
test('R10B raw payload/credential를 journal entry에 추가하면 거부한다',async()=>{
  const f=makeProducerFixture(),{key}=await prepare(f),snapshot=await f.backend.load();
  snapshot.state.entries[key].payload={private:'value'};
  await assert.rejects(f.backend.compareAndSwap(snapshot.revision,snapshot.state),{code:'STATE_INVALID'});
});
test('R10B checkpoint identity mismatch는 완료로 위조하지 않는다',async()=>{
  const f=makeProducerFixture(),{key,message}=await prepare(f);await f.journal.markAccepted(key);
  await f.journal.reconcile('O',{checkpoint:{accession:message.accession,sourceIdentity:'f'.repeat(64),schemaVersion:1}});
  assert.equal((await f.journal.get(key)).state,'ACCEPTED');
});
test('R10B exact checkpoint만 COMPLETED_RECONCILED로 전환한다',async()=>{
  const f=makeProducerFixture(),{key,message}=await prepare(f);await f.journal.markAmbiguous(key);
  await f.journal.reconcile('O',{checkpoint:{accession:message.accession,sourceIdentity:message.sourceIdentity,schemaVersion:1}});
  assert.equal((await f.journal.get(key)).state,'COMPLETED_RECONCILED');
});
test('R10B source 없는 runtime pending만으로 REVIEW_BLOCKED를 추측하지 않는다',async()=>{
  const f=makeProducerFixture(),{key,message}=await prepare(f);await f.journal.markAccepted(key);
  await f.journal.reconcile('O',{reviewEvidence:{accession:message.accession,status:'pending_review',schemaVersion:1}});
  assert.equal((await f.journal.get(key)).state,'ACCEPTED');
});
test('R10B exact review source 증거는 REVIEW_BLOCKED이며 completion과 구별된다',async()=>{
  const f=makeProducerFixture(),{key,message}=await prepare(f);await f.journal.markAccepted(key);
  await f.journal.reconcile('O',{reviewEvidence:{accession:message.accession,sourceIdentity:message.sourceIdentity,status:'pending_review',schemaVersion:1}});
  assert.equal((await f.journal.get(key)).state,'REVIEW_BLOCKED');assert.equal((await f.journal.listUnresolved('O')).length,0);
});
test('R10B INTENT 예약은 durable daily budget을 원자적으로 소비한다',async()=>{
  const f=makeProducerFixture(),{input,key}=await prepare(f),snapshot=await f.backend.load();
  assert.equal(snapshot.state.days['2026-10-06'],1);await f.journal.markFailed(key);
  await f.journal.putIntent(input);assert.equal((await f.backend.load()).state.days['2026-10-06'],1);
});
test('R10B SOURCE_NOT_INDEXED는 세 번 후 operator required로 제한된다',async()=>{
  const f=makeProducerFixture();await f.journal.acquire({runId:'run',owner:'owner',target:fixtureTarget});
  const input={ticker:'O',accession:'0000726728-26-000002',runId:'run',owner:'owner'};
  for (let i=0;i<3;i++) await f.journal.deferNotIndexed(input);
  assert.deepEqual((await f.journal.delayed('O',input.accession)).attempts,3);
  assert.equal((await f.journal.delayed('O',input.accession)).status,'OPERATOR_REQUIRED');
});
