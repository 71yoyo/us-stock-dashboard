import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAutomationPolicy,fixtureRelease,fixtureTarget,fixtureTime,makeProducerFixture } from './helpers/sec-raw-automation-fixtures.js';
import { validateAutomationPolicy,assertPolicyMessage } from '../scripts/sec-raw-automation-policy.mjs';
import { establishReadiness,assertReadiness,createD1ProducerReader } from '../scripts/sec-raw-automation-readiness.mjs';
import { createRawRuntimeDatabase } from './helpers/sec-standard-raw-runtime-db.js';
import { addMigrationLedger } from './helpers/sec-raw-promotion-fixtures.js';

const validate=(policy,options={})=>validateAutomationPolicy(policy,{release:fixtureRelease,target:fixtureTarget,now:fixtureTime,...options});
test('R10B 자동화 policy는 strict allowlist와 immutable scope를 가진다',()=>{
  const policy=validate(makeAutomationPolicy());assert.ok(Object.isFrozen(policy.scope[0]));
  assert.throws(()=>{policy.scope.push({});},TypeError);
});
for (const [label,changes,code] of [
  ['만료',{expiresAt:new Date(fixtureTime).toISOString()},'POLICY_TIME'],
  ['시작 전',{validFrom:new Date(fixtureTime+1000).toISOString()},'POLICY_TIME'],
  ['schema mismatch',{schemaVersion:2},'POLICY_INVALID'],
  ['LMT',{scope:[{ticker:'LMT',cik:'936468'}]},'SCOPE_MISMATCH'],
  ['중복 scope',{scope:[{ticker:'O',cik:'726728'},{ticker:'O',cik:'726728'}]},'SCOPE_MISMATCH'],
  ['잘못된 CIK',{scope:[{ticker:'O',cik:'bad'}]},'SCOPE_MISMATCH'],
  ['101 scope',{scope:Array.from({length:101},(_,i)=>({ticker:`T${i}`,cik:String(i+1)}))},'SCOPE_MISMATCH'],
  ['publish 한도',{maxPublishesPerRun:101},'POLICY_INVALID'],
  ['daily 한도',{maxPublishesPerRun:2,maxPublishesPerDay:1},'POLICY_INVALID'],
  ['payload 한도',{maxPayloadBytes:64001},'POLICY_INVALID'],
  ['provider budget',{maxProviderRequests:301},'POLICY_INVALID'],
  ['지원하지 않는 form',{allowedForms:['8-K']},'POLICY_INVALID'],
  ['추가 credential 필드',{token:'synthetic-never-persist'},'POLICY_INVALID'],
]) test(`R10B policy ${label} fail-closed`,()=>assert.throws(()=>validate(makeAutomationPolicy(changes)),{code}));
test('R10B HEAD/release 불일치 거부',()=>assert.throws(()=>validate(makeAutomationPolicy(),{release:'f'.repeat(40)}),{code:'RELEASE_MISMATCH'}));
test('R10B account/DB/Queue target 불일치 거부',()=>{
  for (const key of Object.keys(fixtureTarget)) assert.throws(()=>validate(makeAutomationPolicy(),{target:{...fixtureTarget,[key]:'mismatch'}}),{code:'TARGET_MISMATCH'});
});
test('R10B historical envelope를 자동화 policy로 재사용할 수 없다',()=>assert.throws(()=>validate({approvalVersion:1,checkpoint:fixtureRelease}),{code:'POLICY_INVALID'}));
test('R10B policy manifest 변조 거부',()=>{
  const p=makeAutomationPolicy();p.maxPublishesPerRun=2;assert.throws(()=>validate(p),{code:'POLICY_INVALID'});
});
test('R10B scope 외 ticker와 다른 CIK message 거부',async()=>{
  const f=makeProducerFixture(),message=await f.message();
  assert.throws(()=>assertPolicyMessage(f.policy,{...message,ticker:'MSFT'}),{code:'SCOPE_MISMATCH'});
  assert.throws(()=>assertPolicyMessage(f.policy,{...message,filing:{...message.filing,cik:'1'}}),{code:'SCOPE_MISMATCH'});
});
test('R10B 승인 payload bytes를 초과하면 거부',async()=>{
  const f=makeProducerFixture();
  const message=await f.message();assert.throws(()=>assertPolicyMessage(makeAutomationPolicy({maxPayloadBytes:10}),message),{code:'MESSAGE_INVALID'});
});
test('R10B readiness는 run당 작은 snapshot 한 번이며 receipt 위조/시간/범위 변경을 거부한다',async()=>{
  const f=makeProducerFixture(),p=validate(f.policy);
  const receipt=await establishReadiness({policy:p,reader:f.reader,runId:'test-run',now:f.now});
  assert.ok(Object.isFrozen(receipt.historical.O));assert.deepEqual(f.queries,['run-readiness']);
  assertReadiness(receipt,p,'test-run',f.now());
  assert.throws(()=>assertReadiness(structuredClone(receipt),p,'test-run',f.now()),{code:'RECEIPT_INVALID'});
  assert.throws(()=>assertReadiness(receipt,{...p,scope:[]},'test-run',f.now()),{code:'RECEIPT_INVALID'});
  assert.throws(()=>assertReadiness(receipt,p,'other',f.now()),{code:'RECEIPT_INVALID'});
  assert.throws(()=>assertReadiness(receipt,p,'test-run',f.now()+300000),{code:'RECEIPT_INVALID'});
});
for (const [label,change] of [['migration',{migration:21}],['historical 없음',{historical_accession:null}],['runtime 없음',{raw_data_version:null}],
  ['schema',{raw_schema_version:2}],['CIK',{cik:'1'}],['runtime error',{raw_status:'error'}],['완료 행 없음',{record_count:0}],['미지원 data version',{raw_data_version:3}]])
  test(`R10B readiness ${label}는 STOP`,async()=>{
    const f=makeProducerFixture();Object.assign(f.readiness[0],change);
    await assert.rejects(establishReadiness({policy:validate(f.policy),reader:f.reader,runId:'test',now:f.now}),{code:'READINESS_INVALID'});
  });
test('R10B 실제 SQL adapter는 readiness 1 SELECT + ticker당 indexed 3 SELECT이며 raw/provenance를 읽지 않는다',async()=>{
  const ctx=createRawRuntimeDatabase();
  try {
    addMigrationLedger(ctx);
    ctx.sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('O','합성','726728');
      INSERT INTO sec_raw_runtime(ticker,raw_schema_version,raw_data_version,raw_status,record_count,available_count) VALUES ('O',1,2,'ready',953,709);
      INSERT INTO sec_raw_payload_checkpoint(ticker,channel,accession,schema_version,source_identity) VALUES ('O','historical','0000726728-26-000001',1,'${'b'.repeat(64)}')`);
    ctx.DB.identity=async()=>({uuid:fixtureTarget.databaseId,name:fixtureTarget.databaseName,accountId:fixtureTarget.accountId});
    const reader=createD1ProducerReader(ctx.DB);ctx.reset();
    await establishReadiness({policy:validate(makeAutomationPolicy()),reader,runId:'test',now:()=>fixtureTime});
    await reader.ticker('O');
    assert.equal(ctx.stats.length,4);assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));
    assert.ok(ctx.stats.every(row=>!/sec_standard_raw_(metrics|provenance)/.test(row.sql)));
    assert.equal(ctx.batchCalls,0);
  } finally {ctx.sqlite.close();}
});
