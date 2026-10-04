import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRawRuntimeDatabase } from './helpers/sec-standard-raw-runtime-db.js';
import { addFact,secFact } from './helpers/sec-standard-raw-fixtures.js';
import { buildCompactSecRawMessage,enqueueCompactSecRaw,onSecRawAccessionDetected } from '../scripts/sec-raw-compact-producer.mjs';
import { validateCompactSecRawMessage,rawSourceIdentity,rawMessageSource } from '../worker/src/sec-raw-message.js';
import { consumeCompactSecRaw,handleSecRawQueue } from '../worker/src/sec-raw-queue.js';
import { importHistoricalSecRaw,parseHistoricalArguments } from '../scripts/sec-raw-historical-import.mjs';
import { validateStandardRawRecords } from '../worker/src/sec-standard-raw-store.js';

const accession='0000726728-26-000001',previous='0000726728-25-000001';
const databaseId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const target={databaseId,allowedDatabaseId:databaseId,name:'disposable-r7'};
const payload=(acc=accession,cash=10)=>{
  const facts={};
  for(const [tag,val] of [['Revenues',100],['NetIncomeLoss',20],['CashAndCashEquivalentsAtCarryingValue',cash],['Assets',200]])
    addFact(facts,tag,secFact(/Cash|Assets/.test(tag)?null:'2025-01-01','2025-12-31',val,{accn:acc}));
  addFact(facts,'EntityCommonStockSharesOutstanding',secFact(null,'2026-02-02',50,{accn:acc}),'shares','dei');
  return {cik:726728,facts};
};
const build=(companyFacts=payload())=>buildCompactSecRawMessage({ticker:'O',accession:companyFacts.facts['us-gaap'].Revenues.units.USD[0].accn,companyFacts});
const setup=()=>{
 const ctx=createRawRuntimeDatabase();ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','로컬 합성 검증'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source) VALUES ('O','annual','2025-12-31',42,'TEST')");
 ctx.DB.identity=async()=>({uuid:databaseId,name:target.name});
 ctx.env={DB:ctx.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true',SEC_STANDARD_RAW_QUEUE_ENABLED:'true'};
 return ctx;
};
const queueMessage=(body,id='test-message')=>({body,id,attempts:1,ackCount:0,retryCount:0,
 ack(){this.ackCount++;},retry(options){this.retryCount++;this.delay=options.delaySeconds;}});
const consume=(ctx,body,id)=>consumeCompactSecRaw(queueMessage(body,id),ctx.env);
const snapshot=ctx=>JSON.stringify(['sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_payload_checkpoint']
 .map(table=>ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const state=ctx=>ctx.sqlite.prepare("SELECT * FROM sec_raw_runtime WHERE ticker='O'").get();
const historical=(ctx,options={})=>importHistoricalSecRaw({tickers:['O'],loadCompanyFacts:async()=>({companyFacts:payload()}),DB:ctx.DB,target,...options});

test('R7 migration 0022 additive-only: existing 0021의 값/registry 그대로',()=>{
 const ctx=createRawRuntimeDatabase(21);try{
  ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','테스트'); INSERT INTO sec_raw_runtime(ticker,raw_status,raw_last_accession) VALUES ('O','ready','old')");
  const before=state(ctx);const sql=readFileSync(new URL('../worker/migrations/0022_sec_raw_payload_checkpoint.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/\b(DROP|ALTER|UPDATE|DELETE)\b/i);ctx.sqlite.exec(sql);assert.deepEqual(state(ctx),before);
 }finally{ctx.sqlite.close();}
});
test('R7 producer는 전체 원문/다른 accession/custom/debt/provider metadata를 보내지 않는다',async()=>{
 const source=payload();source.entityName='보낼 필요 없는 이름';source.facts.custom={Secret:{units:{USD:[secFact()]}}};
 addFact(source.facts,'DebtCurrent',secFact(null,'2025-12-31',10,{accn:accession}));
 addFact(source.facts,'Assets',secFact(null,'2024-12-31',190,{accn:previous}));
 const message=await build(source);assert.equal(message.version,1);assert.equal(message.facts.custom,undefined);assert.equal(message.entityName,undefined);
 assert.equal(message.facts['us-gaap'].DebtCurrent,undefined);assert.equal(message.facts['us-gaap'].Assets.units.USD.length,1);
 const {records}=await validateCompactSecRawMessage(message);
 assert.ok(records.some(row=>row.metricName==='shares_outstanding'&&row.periodEnd==='2026-02-02'));
 assert.ok(records.some(row=>row.availability==='missing'));
});
test('R7 producer dry-run 기본값과 injectable Queue; queued는 ready가 아님',async()=>{
 const message=await build();let calls=0;const queue={send:async()=>{calls++;}};
 assert.equal((await enqueueCompactSecRaw(message,{queue})).status,'dry-run');assert.equal(calls,0);
 assert.equal((await enqueueCompactSecRaw(message,{queue,enabled:true,dryRun:false})).status,'queued');assert.equal(calls,1);
 await assert.rejects(enqueueCompactSecRaw(message,{enabled:true,dryRun:false}));
});
test('R7 enqueue timestamp는 semantic identity를 바꾸지 않는다',async()=>{
 const a=await build(),b=await build();b.enqueuedAt='2026-10-05T03:00:00Z';
 await validateCompactSecRawMessage(b);assert.equal(a.idempotencyKey,b.idempotencyKey);
});
test('R7 Node accession event stub은 기본 dry-run, 명시적 Queue 전송은 queued만 반환',async()=>{
 const event={ticker:'O',accession,companyFacts:payload()};let calls=0;
 assert.equal((await onSecRawAccessionDetected(event)).status,'dry-run');
 assert.equal((await onSecRawAccessionDetected(event,{enabled:true,dryRun:false,queue:{send:async()=>{calls++;}}})).status,'queued');
 assert.equal(calls,1);
});

const mutations=[['invalid JSON',()=>'{'],['unsupported version',m=>{m.version=99;}],['missing ticker',m=>{delete m.ticker;}],
 ['missing accession',m=>{delete m.accession;}],['malformed accession',m=>{m.accession='bad';}],
 ['mixed accession',m=>{m.facts['us-gaap'].Assets.units.USD[0].accn=previous;}],
 ['duplicate input identity',m=>{const r=m.facts['us-gaap'].Assets.units.USD;r.push({...r[0]});}],
 ['unapproved metric identity',m=>{m.facts['us-gaap'].TotalDebt=m.facts['us-gaap'].Assets;}],
 ['secret extra field',m=>{m.credential='forbidden-test';}],['source hash mismatch',m=>{m.sourceIdentity='0'.repeat(64);}],
 ['invalid period',m=>{m.facts['us-gaap'].Assets.units.USD[0].end='2025-02-30';}],
 ['invalid unit',m=>{m.facts['us-gaap'].Assets.units.EUR=m.facts['us-gaap'].Assets.units.USD;}],
 ['invalid value',m=>{m.facts['us-gaap'].Assets.units.USD[0].val=null;}]];
for(const [label,mutate] of mutations)test(`R7 ${label}: reject/ack, DB 호출 0`,async()=>{
 const ctx=setup();try{let message=await build();message=mutate(message)||message;ctx.reset();
  const delivered=queueMessage(message);assert.equal((await consumeCompactSecRaw(delivered,ctx.env)).status,'rejected');
  assert.equal(delivered.ackCount,1);assert.equal(delivered.retryCount,0);assert.equal(ctx.stats.length,0);
 }finally{ctx.sqlite.close();}
});
test('R7 flags 기본 OFF: DB 호출/입력 파싱 없음, 재시도',async()=>{
 const ctx=setup();try{ctx.env.SEC_STANDARD_RAW_QUEUE_ENABLED=undefined;ctx.reset();
 const m=queueMessage('{');assert.equal((await consumeCompactSecRaw(m,ctx.env)).status,'disabled');assert.equal(ctx.stats.length,0);assert.equal(m.retryCount,1);
 }finally{ctx.sqlite.close();}
});
for(const id of ['same-message','different-message'])test(`R7 ${id} 재전송: raw/provenance/checkpoint write 0`,async()=>{
 const ctx=setup();try{const message=await build();assert.equal((await consume(ctx,message,'same-message')).status,'ready');
  const before=snapshot(ctx),registry=state(ctx);ctx.reset();const result=await consume(ctx,message,id);
  assert.equal(result.status,'unchanged');assert.equal(ctx.batchCalls,0);assert.equal(ctx.stats.reduce((s,x)=>s+x.logicalChanges,0),0);
  assert.equal(snapshot(ctx),before);assert.deepEqual(state(ctx),registry);
 }finally{ctx.sqlite.close();}
});
test('R7 same accession changed payload: shortcut 금지/review/기존 checkpoint 보존',async()=>{
 const ctx=setup();try{await consume(ctx,await build());const oldCheckpoint=ctx.sqlite.prepare('SELECT * FROM sec_raw_payload_checkpoint').get();
 const result=await consume(ctx,await build(payload(accession,11)));assert.equal(result.status,'pending_review');
 assert.equal(ctx.sqlite.prepare("SELECT metric_value v FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().v,10);
 assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM sec_raw_payload_checkpoint').get(),oldCheckpoint);assert.equal(state(ctx).raw_status,'pending');
 }finally{ctx.sqlite.close();}
});
test('R7 new accession same values: 새 provenance append/이전 numeric 보존',async()=>{
 const ctx=setup();try{await consume(ctx,await build(payload(previous)));const before=ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n;
 assert.equal((await consume(ctx,await build())).status,'ready');assert.ok(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n>before);
 assert.equal(state(ctx).raw_last_accession,accession);assert.equal(ctx.sqlite.prepare('SELECT revenue FROM financial_metrics').get().revenue,42);
 }finally{ctx.sqlite.close();}
});
test('R7 NULL → available: review로 ack, 이전 successful accession 보존',async()=>{
 const ctx=setup();try{await consume(ctx,await build(payload(previous)));
 ctx.sqlite.exec("UPDATE sec_standard_raw_metrics SET metric_value=NULL,source_fingerprint=NULL,availability='missing' WHERE metric_name='cash_and_cash_equivalents'");
 const result=await consume(ctx,await build());assert.equal(result.status,'pending_review');assert.equal(result.action,'ack');
 assert.equal(state(ctx).raw_last_accession,previous);assert.equal(ctx.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().metric_value,null);
 }finally{ctx.sqlite.close();}
});
test('R7 definition/entity scope conflict는 pending_review, ready 자동 승격 금지',async()=>{
 const ctx=setup();try{const source=payload();source.facts['us-gaap'].Assets.units.USD[0].entityScope='parent';
 const result=await consume(ctx,await build(source));assert.equal(result.status,'pending_review');assert.equal(state(ctx).raw_status,'pending');
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_payload_checkpoint').get().n,0);
 }finally{ctx.sqlite.close();}
});
for(const stage of ['middle-write','provenance','checkpoint','registry'])test(`R7 ${stage} D1 failure: 원자 rollback/성공 checkpoint 보존/재시도`,async()=>{
 const ctx=setup();try{await consume(ctx,await build(payload(previous)));const before=snapshot(ctx),prior=state(ctx).raw_last_accession;
 const table={ 'middle-write':'sec_standard_raw_metrics',provenance:'sec_standard_raw_provenance',checkpoint:'sec_raw_payload_checkpoint',registry:'sec_raw_runtime'}[stage];
 const action=stage==='registry'?'UPDATE':'INSERT';const when=stage==='registry'?"WHEN NEW.raw_status='ready'":'';
 ctx.sqlite.exec(`CREATE TRIGGER fail_r7 BEFORE ${action} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'TEST'); END`);
 const result=await consume(ctx,await build());assert.equal(result.action,'retry');assert.equal(result.status,'error');
 assert.equal(snapshot(ctx),before);assert.equal(state(ctx).raw_last_accession,prior);
 ctx.sqlite.exec('DROP TRIGGER fail_r7; UPDATE sec_raw_runtime SET next_run_at=NULL');assert.equal((await consume(ctx,await build())).status,'ready');
 }finally{ctx.sqlite.close();}
});
for(const change of ["lease_token='other-owner'","fence=fence+1"])test(`R7 fencing ${change}: partial semantic corruption 0`,async()=>{
 const ctx=setup();try{const batch=ctx.DB.batch;ctx.DB.batch=async statements=>{ctx.sqlite.exec(`UPDATE sec_raw_runtime SET ${change}`);return batch(statements);};
 const result=await consume(ctx,await build());assert.equal(result.action,'retry');assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R7 lease contention은 retry, 기존 owner 불변',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("INSERT INTO sec_raw_runtime(ticker,lease_token,lease_until,raw_status) VALUES ('O','owner','2099-01-01','running')");
 assert.equal((await consume(ctx,await build())).status,'deferred');assert.equal(state(ctx).lease_token,'owner');
 }finally{ctx.sqlite.close();}
});
test('R7 temporary D1 unavailable은 retry, raw 쓰기 없음',async()=>{
 const ctx=setup();try{ctx.DB.prepare=()=>{throw Error('secret-url-must-not-escape');};
 const result=await consume(ctx,await build());assert.equal(result.action,'retry');assert.doesNotMatch(JSON.stringify(result),/secret-url/);
 }finally{ctx.sqlite.close();}
});
test('R7 JSON 입력 처리/queue handler 복수 delivery',async()=>{
 const ctx=setup();try{const body=JSON.stringify(await build());const a=queueMessage(body),b=queueMessage(body,'second');
 const result=await handleSecRawQueue({messages:[a,b]},ctx.env);assert.deepEqual(result.map(x=>x.status),['ready','unchanged']);
 }finally{ctx.sqlite.close();}
});
test('R7 raw record duplicate/invalid metric validation은 claim 전 거부',async()=>{
 const {records}=await validateCompactSecRawMessage(await build());assert.throws(()=>validateStandardRawRecords([records[0],records[0]]));
 assert.throws(()=>validateStandardRawRecords([{...records[0],metricName:'total_debt'}]));
});
test('R7 importer default dry-run은 DB/network 불필요, single/list 지원',async()=>{
 const ctx=setup();try{ctx.reset();assert.equal((await historical(ctx)).results[0].status,'dry-run');assert.equal(ctx.stats.length,0);
 const result=await importHistoricalSecRaw({tickers:['O','MSFT'],loadCompanyFacts:async()=>({companyFacts:payload()})});assert.equal(result.results.length,2);
 }finally{ctx.sqlite.close();}
});
for(const options of [{apply:true},{apply:true,enabled:true,target:undefined},
 {apply:true,enabled:true,target:{...target,databaseId:'698ab9b8-4573-40c7-b119-d7b1d681abc8',allowedDatabaseId:'698ab9b8-4573-40c7-b119-d7b1d681abc8'}},
 {apply:true,enabled:true,target:{...target,name:'wrong'}}])test('R7 importer explicit write/production/identity guard',async()=>{
 const ctx=setup();try{await assert.rejects(historical(ctx,options));assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R7 historical write/resume same payload: raw/provenance writes 0',async()=>{
 const ctx=setup();try{assert.equal((await historical(ctx,{apply:true,enabled:true})).results[0].status,'ready');const before=snapshot(ctx);ctx.reset();
 assert.equal((await historical(ctx,{apply:true,enabled:true,resume:true})).results[0].status,'unchanged');
 assert.equal(snapshot(ctx),before);assert.equal(ctx.stats.reduce((s,x)=>s+x.logicalChanges,0),0);
 }finally{ctx.sqlite.close();}
});
test('R7 historical failed-only retry: successful job 제외/실패 job 안전 재시도',async()=>{
 const ctx=setup();try{const opts={apply:true,enabled:true};await historical(ctx,opts);
 assert.equal((await historical(ctx,{...opts,retryFailedOnly:true})).results[0].status,'skipped-not-failed');
 ctx.sqlite.exec("DELETE FROM sec_raw_payload_checkpoint; CREATE TRIGGER fail_hist BEFORE INSERT ON sec_standard_raw_provenance BEGIN SELECT RAISE(ABORT,'TEST'); END");
 assert.equal((await historical(ctx,opts)).results[0].status,'error');ctx.sqlite.exec('DROP TRIGGER fail_hist');
 assert.equal((await historical(ctx,{...opts,retryFailedOnly:true})).results[0].status,'ready');
 }finally{ctx.sqlite.close();}
});
test('R7 historical middle failure: 이전 ticker의 successful checkpoint 보호',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('MSFT','合成テスト'); CREATE TRIGGER fail_msft BEFORE INSERT ON sec_standard_raw_provenance WHEN NEW.ticker='MSFT' BEGIN SELECT RAISE(ABORT,'TEST'); END");
 const result=await importHistoricalSecRaw({tickers:['O','MSFT'],loadCompanyFacts:async()=>({companyFacts:payload()}),DB:ctx.DB,target,apply:true,enabled:true});
 assert.deepEqual(result.results.map(x=>x.status),['ready','error']);assert.equal(state(ctx).raw_last_accession,accession);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_metrics WHERE ticker='MSFT'").get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R7 CLI는ticker/list/cache/explicit apply만 허용한다',()=>{
 assert.equal(parseHistoricalArguments(['--ticker','O','--cache-dir','local-cache']).apply,false);
 assert.deepEqual(parseHistoricalArguments(['--tickers','O,MSFT','--cache-dir','local-cache']).tickers,['O','MSFT']);
 assert.throws(()=>parseHistoricalArguments(['--ticker','../O','--cache-dir','local-cache']));
 assert.throws(()=>parseHistoricalArguments(['--bad']));
});
test('R7 historical cache loader 실패는 raw-only error로 기록하고 failed-only 재시도',async()=>{
 const ctx=setup();try{
  const failure=await historical(ctx,{apply:true,enabled:true,loadCompanyFacts:async()=>{throw Error('private input path');}});
  assert.equal(failure.results[0].status,'error');assert.equal(state(ctx).raw_status,'error');
  assert.equal((await historical(ctx,{apply:true,enabled:true,retryFailedOnly:true})).results[0].status,'ready');
  assert.equal(ctx.sqlite.prepare('SELECT revenue FROM financial_metrics').get().revenue,42);
 }finally{ctx.sqlite.close();}
});
test('R7 historical issuer CIK 불일치는 raw 값 저장 없이 거부',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("UPDATE companies SET cik='123' WHERE ticker='O'");
 assert.equal((await historical(ctx,{apply:true,enabled:true})).results[0].status,'error');
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R7 Worker는Node importer를import하지 않고Production config/flags는기본OFF',async()=>{
 const src=readFileSync(new URL('../worker/src/index.js',import.meta.url),'utf8');assert.match(src,/async queue\(batch, environment\)/);
 assert.doesNotMatch(src,/sec-raw-historical-import|sec-raw-compact-producer/);
 const env={};assert.equal((await consumeCompactSecRaw(queueMessage({}),env)).status,'disabled');
});
