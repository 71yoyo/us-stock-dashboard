import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createD1MetaCollector,observeSecRawQueue,rawTelemetryEnabled} from '../worker/src/sec-raw-telemetry.js';
import {handleSecRawQueue,consumeCompactSecRaw} from '../worker/src/sec-raw-queue.js';
import entry from '../worker/src/sec-raw-consumer-entry.js';
import {buildCompactSecRawMessage} from '../scripts/sec-raw-compact-producer.mjs';
import {addFact,secFact} from './helpers/sec-standard-raw-fixtures.js';
import {createTelemetryTestDatabase} from './helpers/sec-raw-telemetry-db.js';

const accession='0000726728-26-000001',oldAccession='0000726728-25-000001';
const makePayload=async(acc=accession,cash=10)=>{
 const facts={};
 for(const [tag,val] of [['Revenues',100],['NetIncomeLoss',20],['CashAndCashEquivalentsAtCarryingValue',cash],['Assets',200]])
  addFact(facts,tag,secFact(/Cash|Assets/.test(tag)?null:'2025-01-01','2025-12-31',val,{accn:acc}));
 return buildCompactSecRawMessage({ticker:'O',accession:acc,companyFacts:{cik:726728,facts}});
};
const delivery=body=>({body,id:'queue-provided-message',attempts:1,acks:0,retries:0,
 ack(){this.acks++;},retry(options){this.retries++;this.delay=options.delaySeconds;}});
const env=(ctx,flag)=>({DB:ctx.DB,SEC_STANDARD_RAW_QUEUE_ENABLED:'true',SEC_STANDARD_RAW_TELEMETRY_ENABLED:flag});
const setup=()=>{
 const ctx=createTelemetryTestDatabase();ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','합성 테스트'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source) VALUES ('O','annual','2025-12-31',42,'TEST')");return ctx;
};
const snapshot=ctx=>JSON.stringify(['companies','financial_metrics','sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_runtime','sec_raw_payload_checkpoint','sec_raw_runtime_guard']
 .map(table=>ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
 .map(({created_at,updated_at,completed_at,raw_last_success_at,...r})=>r)));
async function capture(operation){
 const log=console.log,logs=[];console.log=value=>logs.push(value);
 try{return {result:await operation(),logs};}finally{console.log=log;}
}
function stubDatabase({meta={rows_read:2,rows_written:3,duration:0.5,changes:1},results=[{v:7}],failure=false}={}){
 const calls=[];
 const make=sql=>({sql,bind(...values){this.values=values;return this;},
 async all(){calls.push('all');if(failure)throw Error('synthetic-secret-error');return {results,meta};},
 async run(){calls.push('run');if(failure)throw Error('synthetic-secret-error');return {results,meta};}});
 return {calls,DB:{prepare:make,async batch(items){calls.push('batch');if(failure)throw Error('synthetic-secret-error');
  return items.map(()=>({results,meta}));}}};
}

for(const flag of [undefined,'false',false,'TRUE',true,'1']) test(`R9D-TEL flag ${String(flag)}는 기본 OFF`,()=>{
 assert.equal(rawTelemetryEnabled({SEC_STANDARD_RAW_TELEMETRY_ENABLED:flag}),false);
});
test('R9D-TEL 명시적 문자열 true만 ON',()=>assert.equal(rawTelemetryEnabled({SEC_STANDARD_RAW_TELEMETRY_ENABLED:'true'}),true));
test('R9D-TEL collector all/run 원래 result 반환, call/statement exact',async()=>{
 const s=stubDatabase(),c=createD1MetaCollector(s.DB);
 const a=await c.DB.prepare('SELECT v').all(),r=await c.DB.prepare('UPDATE test SET v=?').bind(3).run();
 assert.equal(a.meta,r.meta);assert.deepEqual(s.calls,['all','run']);
 assert.deepEqual(Object.fromEntries(['d1Calls','singleCalls','batchCalls','sqlStatements'].map(k=>[k,c.snapshot()[k]])),{d1Calls:2,singleCalls:2,batchCalls:0,sqlStatements:2});
});
for(const [field,expected] of [['rowsRead',4],['rowsWritten',6],['d1DurationMs',1]]) test(`R9D-TEL ${field} meta 정확 합산`,async()=>{
 const c=createD1MetaCollector(stubDatabase().DB);await c.DB.prepare('SELECT v').all();await c.DB.prepare('SELECT v').run();assert.equal(c.snapshot()[field],expected);
});
test('R9D-TEL batch 1 call / N SQL, meta 중복 없이 각각 합산',async()=>{
 const s=stubDatabase(),c=createD1MetaCollector(s.DB),statements=[c.DB.prepare('SELECT a'),c.DB.prepare('SELECT b').bind('private-bind')];
 const r=await c.DB.batch(statements);assert.equal(r.length,2);assert.deepEqual(s.calls,['batch']);
 const m=c.snapshot();assert.equal(m.d1Calls,1);assert.equal(m.batchCalls,1);assert.equal(m.sqlStatements,2);assert.equal(m.rowsRead,4);assert.equal(m.rowsWritten,6);assert.equal(m.d1DurationMs,1);
});
test('R9D-TEL first는 동일 SQL 실행 1회, 행/column/null 규칙 보존',async()=>{
 const s=stubDatabase(),c=createD1MetaCollector(s.DB);
 assert.deepEqual(await c.DB.prepare('SELECT v').first(),{v:7});assert.equal(await c.DB.prepare('SELECT v').first('v'),7);
 await assert.rejects(c.DB.prepare('SELECT v').first('missing'),/D1_COLUMN_NOTFOUND/);assert.equal(c.snapshot().d1Calls,3);assert.deepEqual(s.calls,['all','all','all']);
 assert.equal(await createD1MetaCollector(stubDatabase({results:[]}).DB).DB.prepare('SELECT v').first(),null);
});
test('R9D-TEL first의 0/false/null cell 보존',async()=>{
 for(const v of [0,false,null])assert.equal(await createD1MetaCollector(stubDatabase({results:[{v}]}).DB).DB.prepare('SELECT v').first('v'),v);
});
test('R9D-TEL meta 부재는 unknown/null이지 0이 아님',async()=>{
 const c=createD1MetaCollector(stubDatabase({meta:undefined}).DB);
 // stub 기본 인자가 meta를 제공하므로 명시적 null 응답으로 부재를 재현한다.
 const absent=createD1MetaCollector(stubDatabase({meta:null}).DB);await absent.DB.prepare('SELECT v').all();
 assert.equal(absent.snapshot().rowsWritten,null);assert.equal(absent.snapshot().metaComplete,false);assert.equal(c.snapshot().rowsWritten,0);
});
test('R9D-TEL 잘못된 meta 숫자는 문자열/NaN/음수를 로그로 옮기지 않음',async()=>{
 const c=createD1MetaCollector(stubDatabase({meta:{rows_read:'private-bind',rows_written:-1,duration:NaN}}).DB);
 await c.DB.prepare('SELECT v').all();const m=c.snapshot();assert.equal(m.rowsRead,null);assert.equal(m.rowsWritten,null);assert.equal(m.d1DurationMs,null);assert.doesNotMatch(JSON.stringify(m),/private-bind/);
});
test('R9D-TEL failed call은 재시도 없이 동일 예외 보존, 부분 meta는 unknown',async()=>{
 const s=stubDatabase({failure:true}),c=createD1MetaCollector(s.DB);await assert.rejects(c.DB.prepare('SELECT v').all(),/synthetic-secret-error/);
 assert.equal(c.snapshot().d1Calls,1);assert.equal(c.snapshot().failedCalls,1);assert.equal(c.snapshot().rowsWritten,null);assert.deepEqual(s.calls,['all']);
});
test('R9D-TEL batch 실패는 delta/과금 비용 미확정, raw 예외 노출 없음',async()=>{
 const c=createD1MetaCollector(stubDatabase({failure:true}).DB);
 await assert.rejects(c.DB.batch([c.DB.prepare('INSERT INTO sec_standard_raw_metrics VALUES (?)')]),/synthetic-secret-error/);
 assert.equal(c.snapshot().rawDelta,null);assert.equal(c.snapshot().rowsWritten,null);assert.doesNotMatch(JSON.stringify(c.snapshot()),/synthetic-secret-error|VALUES/);
});
test('R9D-TEL physical writes와 changes 기반 raw/provenance delta 구분',async()=>{
 const c=createD1MetaCollector(stubDatabase({meta:{rows_read:2,rows_written:12,duration:0.5,changes:1}}).DB);
 await c.DB.batch([c.DB.prepare('INSERT INTO sec_standard_raw_metrics VALUES (?)'),c.DB.prepare('INSERT INTO sec_standard_raw_provenance VALUES (?)')]);
 assert.equal(c.snapshot().rowsWritten,24);assert.equal(c.snapshot().rawDelta,1);assert.equal(c.snapshot().provenanceDelta,1);
});
test('R9D-TEL meta getter 장애는 성공한 D1 결과/추가 호출을 바꾸지 않음',async()=>{
 const meta={get rows_read(){throw Error('private-observer-error');}};
 const s=stubDatabase({meta}),c=createD1MetaCollector(s.DB);
 const result=await c.DB.prepare('SELECT v').all();assert.equal(result.meta,meta);
 assert.equal(c.snapshot().observationFailures,1);assert.equal(c.snapshot().failedCalls,0);
 assert.equal(c.snapshot().rowsWritten,null);assert.deepEqual(s.calls,['all']);
 assert.doesNotMatch(JSON.stringify(c.snapshot()),/private-observer-error/);
});
test('R9D-TEL batch meta getter 장애도 commit 성공 결과를 그대로 반환',async()=>{
 const meta={get changes(){throw Error('private-observer-error');},rows_read:1,rows_written:2,duration:0.5};
 const s=stubDatabase({meta}),c=createD1MetaCollector(s.DB);
 const result=await c.DB.batch([c.DB.prepare('INSERT INTO sec_standard_raw_metrics VALUES (?)')]);
 assert.equal(result.length,1);assert.equal(c.snapshot().rawDelta,null);
 assert.equal(c.snapshot().observationFailures,1);assert.equal(c.snapshot().failedCalls,0);
 assert.deepEqual(s.calls,['batch']);
});
test('R9D-TEL ON 성공 summary 1건과 initial compact mutation',async()=>{
 const ctx=setup();try{const message=await makePayload();const d=delivery(message);const r=await capture(()=>entry.queue({messages:[d]},env(ctx,'true')));
 assert.equal(r.logs.length,1);assert.equal(r.result[0].status,'ready');assert.equal(d.acks,1);assert.equal(d.retries,0);
 const s=r.logs[0];assert.equal(s.event,'sec_raw_queue_summary');assert.equal(s.ticker,'O');assert.equal(s.schemaVersion,1);
 assert.equal(s.sourceIdentity,message.sourceIdentity);assert.equal(s.applicationIdentity,message.idempotencyKey);
 assert.equal(s.rawDelta,r.result[0].records);assert.equal(s.provenanceDelta,r.result[0].available);assert.equal(s.checkpointAction,'written');
 assert.equal(s.rowsWritten,ctx.totals.rowsWritten);assert.equal(s.rowsRead,ctx.totals.rowsRead);assert.equal(s.d1DurationMs,ctx.totals.duration);
 assert.equal(s.d1Calls,ctx.totals.calls);assert.equal(s.sqlStatements,ctx.stats.length);assert.equal(s.metaComplete,true);
 assert.equal(s.deliveryAttempt,1);assert.equal(s.messageId,d.id);assert.equal(s.cpuMs,undefined);
 }finally{ctx.sqlite.close();}
});
for(const flag of [undefined,'false'])test(`R9D-TEL OFF(${flag}) console 0, 기존 consumer 결과 exact`,async()=>{
 const a=setup(),b=setup();try{const message=await makePayload(),da=delivery(message),db=delivery(message);
 const old=await consumeCompactSecRaw(da,env(a,flag),{queueOnly:true});const observed=await capture(()=>entry.queue({messages:[db]},env(b,flag)));
 assert.deepEqual(observed.result,[old]);assert.equal(observed.logs.length,0);assert.equal(snapshot(a),snapshot(b));assert.deepEqual(a.stats.map(r=>r.sql),b.stats.map(r=>r.sql));
 }finally{a.sqlite.close();b.sqlite.close();}
});
test('R9D-TEL ON/OFF processing parity와 추가 D1 query 0',async()=>{
 const a=setup(),b=setup();try{const message=await makePayload();
 const off=await capture(()=>entry.queue({messages:[delivery(message)]},env(a,'false'))),on=await capture(()=>entry.queue({messages:[delivery(message)]},env(b,'true')));
 assert.deepEqual(on.result,off.result);assert.equal(snapshot(a),snapshot(b));assert.deepEqual(a.stats.map(r=>r.sql),b.stats.map(r=>r.sql));
 assert.equal(a.totals.calls,b.totals.calls);assert.equal(a.stats.length,b.stats.length);assert.equal(off.logs.length,0);assert.equal(on.logs.length,1);
 }finally{a.sqlite.close();b.sqlite.close();}
});
test('R9D-TEL duplicate no-op summary rowsWritten 0, runtime/registry 불변',async()=>{
 const ctx=setup();try{const message=await makePayload();await capture(()=>entry.queue({messages:[delivery(message)]},env(ctx,'true')));
 const before=snapshot(ctx);ctx.reset();const r=await capture(()=>entry.queue({messages:[delivery(message)]},env(ctx,'true')));
 assert.equal(r.result[0].status,'unchanged');assert.equal(r.logs.length,1);assert.equal(r.logs[0].rowsWritten,0);assert.equal(r.logs[0].rawDelta,0);assert.equal(r.logs[0].provenanceDelta,0);
 assert.equal(r.logs[0].checkpointAction,'unchanged');assert.equal(r.logs[0].batchCalls,0);assert.equal(snapshot(ctx),before);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL validation failure summary는 허용 identity를 추측하지 않으며 DB 0',async()=>{
 const ctx=setup();try{const invalid={ticker:'O',credential:'synthetic-credential',Authorization:'private-header',email:['private','example.invalid'].join('@'),facts:{USD:123456.789}};
 const d=delivery(invalid),r=await capture(()=>entry.queue({messages:[d]},env(ctx,'true')));
 assert.equal(r.result[0].status,'rejected');assert.equal(d.acks,1);assert.equal(r.logs.length,1);assert.equal(r.logs[0].ticker,null);assert.equal(r.logs[0].d1Calls,0);
 assert.doesNotMatch(JSON.stringify(r.logs),/synthetic-credential|private-header|example.invalid|123456/);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL store failure/retry는 summary 1건, rollback/backoff 의미 유지',async()=>{
 const a=setup(),b=setup();try{for(const c of [a,b])c.sqlite.exec("CREATE TRIGGER fail_tel BEFORE INSERT ON sec_standard_raw_provenance BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END");
 const message=await makePayload(),da=delivery(message),db=delivery(message);
 const off=await capture(()=>entry.queue({messages:[da]},env(a,'false'))),on=await capture(()=>entry.queue({messages:[db]},env(b,'true')));
 assert.deepEqual(on.result,off.result);assert.equal(on.result[0].status,'error');assert.equal(da.retries,db.retries);assert.equal(db.delay,900);
 assert.equal(on.logs.length,1);assert.equal(on.logs[0].retryRequested,true);assert.equal(on.logs[0].rowsWritten,null);assert.equal(on.logs[0].rawDelta,null);
 assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);assert.equal(b.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
 assert.doesNotMatch(JSON.stringify(on.logs),/synthetic-private-error|TRIGGER|BEGIN/);
 }finally{a.sqlite.close();b.sqlite.close();}
});
test('R9D-TEL lease conflict은 retry summary/owner 보호',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("INSERT INTO sec_raw_runtime(ticker,raw_status,lease_token,lease_until) VALUES ('O','running','private-owner','2099-01-01')");
 const r=await capture(async()=>entry.queue({messages:[delivery(await makePayload())]},env(ctx,'true')));
 assert.equal(r.result[0].status,'deferred');assert.equal(r.logs.length,1);assert.equal(r.logs[0].retryRequestCount,1);assert.equal(r.logs[0].rowsWritten,0);assert.doesNotMatch(JSON.stringify(r.logs),/private-owner/);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL transient D1 failure summary, 예외 원문/SQL/bind 없음',async()=>{
 const ctx=setup();try{ctx.DB.prepare=()=>{throw Error('Authorization synthetic-private-token SELECT cash=8888');};
 const r=await capture(async()=>entry.queue({messages:[delivery(await makePayload())]},env(ctx,'true')));
 assert.equal(r.result[0].status,'error');assert.equal(r.logs.length,1);assert.doesNotMatch(JSON.stringify(r.logs),/Authorization|synthetic-private-token|SELECT|8888/);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL review ON/OFF parity, checkpoint와 기존 값 보호',async()=>{
 const a=setup(),b=setup();try{const old=await makePayload(oldAccession),changed=await makePayload(accession,11);
 await capture(()=>entry.queue({messages:[delivery(old)]},env(a,'false')));await capture(()=>entry.queue({messages:[delivery(old)]},env(b,'true')));
 a.reset();b.reset();const off=await capture(()=>entry.queue({messages:[delivery(changed)]},env(a,'false'))),on=await capture(()=>entry.queue({messages:[delivery(changed)]},env(b,'true')));
 assert.deepEqual(on.result,off.result);assert.equal(on.result[0].status,'pending_review');assert.equal(snapshot(a),snapshot(b));
 assert.equal(on.logs[0].outcome,'review_pending');assert.equal(on.logs[0].checkpointAction,'not_written_review');assert.deepEqual(a.stats.map(r=>r.sql),b.stats.map(r=>r.sql));
 }finally{a.sqlite.close();b.sqlite.close();}
});
test('R9D-TEL queue disabled ON/OFF parsing/DB 0, retry 동일',async()=>{
 const ctx=setup();try{const d=delivery('{'),e={...env(ctx,'true'),SEC_STANDARD_RAW_QUEUE_ENABLED:undefined};
 const r=await capture(()=>entry.queue({messages:[d]},e));assert.equal(r.result[0].status,'disabled');assert.equal(d.retries,1);assert.equal(r.logs.length,1);assert.equal(r.logs[0].d1Calls,0);assert.equal(ctx.stats.length,0);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL app Worker 경로에는 flag true라도 instrumentation 없음',async()=>{
 const ctx=setup();try{const r=await capture(async()=>handleSecRawQueue({messages:[delivery(await makePayload())]},
 {...env(ctx,'true'),SEC_STANDARD_RAW_FIELDS_ENABLED:'true'}));assert.equal(r.result[0].status,'ready');assert.equal(r.logs.length,0);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL 복수 메시지도 invocation summary 1건/collector scope 독립',async()=>{
 const ctx=setup();try{const message=await makePayload();const r=await capture(()=>entry.queue({messages:[delivery(message),delivery(message)]},env(ctx,'true')));
 assert.deepEqual(r.result.map(x=>x.status),['ready','unchanged']);assert.equal(r.logs.length,1);assert.equal(r.logs[0].messageCount,2);assert.equal(r.logs[0].messages.length,2);assert.equal(r.logs[0].d1Calls,ctx.totals.calls);
 ctx.reset();const again=await capture(()=>entry.queue({messages:[delivery(message)]},env(ctx,'true')));assert.equal(again.logs[0].rowsWritten,0);assert.equal(again.logs[0].batchCalls,0);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL logger 예외에도 ack/DB 결과 불변',async()=>{
 const ctx=setup();try{const d=delivery(await makePayload());const result=await observeSecRawQueue({messages:[d]},env(ctx,'true'),
 (message,e,onValidated)=>consumeCompactSecRaw(message,e,{queueOnly:true,onValidated}),()=>{throw Error('logger unavailable');});
 assert.equal(result[0].status,'ready');assert.equal(d.acks,1);assert.equal(d.retries,0);
 }finally{ctx.sqlite.close();}
});
test('R9D-TEL unexpected exception에도 summary 1건, 예외 재throw 의미 유지',async()=>{
 const logs=[];const error=Error('synthetic-private-exception');
 await assert.rejects(observeSecRawQueue({messages:[delivery({})]},{},async()=>{throw error;},s=>logs.push(s)),e=>e===error);
 assert.equal(logs.length,1);assert.equal(logs[0].outcome,'exception');assert.doesNotMatch(JSON.stringify(logs),/synthetic-private-exception/);
});
test('R9D-TEL summary에 SQL bind/financial raw/credential/header 없음',async()=>{
 const logs=[],s=stubDatabase({results:[{financial_value:'private-financial-value'}]});
 await observeSecRawQueue({messages:[delivery({raw:'private-companyfacts'})]},
 {DB:s.DB,credential:'private-credential',Authorization:'private-authorization'},async(message,e)=>{
 await e.DB.prepare('SELECT private-secret-sql').bind('private-bind').all();return {status:'ready',action:'ack'};
 },r=>logs.push(r));
 assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify(logs),/private-companyfacts|private-secret-sql|private-bind|private-financial-value|private-credential|private-authorization/);
});
test('R9D-TEL import graph에 Node/remote/deploy/시간 측정 없음',()=>{
 const src=readFileSync(new URL('../worker/src/sec-raw-telemetry.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/node:|\bfetch\s*\(|Date\.now|performance\.now|cpuMs\s*:/);
 assert.doesNotMatch(src,/console\.(warn|error)/);assert.match(src,/sec_raw_queue_summary/);
});
