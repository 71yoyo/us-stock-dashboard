import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompactRawRuntime, extractCompactRawRecords, lookupIncrementalReviews, INCREMENTAL_REVIEW_SQL } from '../worker/src/sec-standard-raw-incremental.js';
import { saveStandardRawMetrics } from '../worker/src/sec-standard-raw-store.js';
import { createRawRuntimeDatabase } from './helpers/sec-standard-raw-runtime-db.js';
import { addFact, secFact } from './helpers/sec-standard-raw-fixtures.js';

const oldAccession='0000726728-25-000001', accession='0000726728-26-000001';
const factsFor=(acc=accession,cash=10)=>{
  const facts={};
  for(const [tag,value] of [['Revenues',100],['NetIncomeLoss',20],['CashAndCashEquivalentsAtCarryingValue',cash],['Assets',200]]) {
    addFact(facts,tag,secFact(/Cash|Assets/.test(tag)?null:'2025-01-01','2025-12-31',value,{accn:acc}));
  }
  addFact(facts,'EntityCommonStockSharesOutstanding',secFact(null,'2026-02-02',50,{accn:acc}),'shares','dei');
  return facts;
};
const setup=()=>{
  const ctx=createRawRuntimeDatabase();
  ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','테스트'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source) VALUES ('O','annual','2025-12-31',42,'TEST')");
  ctx.env={DB:ctx.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'};
  return ctx;
};
const run=(ctx,facts=factsFor(),acc=accession)=>runCompactRawRuntime(ctx.env,'O',acc,async()=>({facts,financialPeriods:[]}));
const raw=ctx=>ctx.sqlite.prepare('SELECT * FROM sec_standard_raw_metrics ORDER BY metric_name,period_type,period_start,period_end').all();
const provenance=ctx=>ctx.sqlite.prepare('SELECT * FROM sec_standard_raw_provenance ORDER BY metric_name,period_type,period_start,period_end,source_fingerprint').all();
const state=ctx=>ctx.sqlite.prepare("SELECT * FROM sec_raw_runtime WHERE ticker='O'").get();

test('R6I 기본 flag false: compact load/DB 작업 없음',async()=>{
  const ctx=setup();try{ctx.env.SEC_STANDARD_RAW_FIELDS_ENABLED=undefined;ctx.reset();
    assert.deepEqual(await run(ctx),{status:'disabled'});assert.equal(ctx.stats.length,0);
  }finally{ctx.sqlite.close();}
});
test('R6I review plan: 후보를 먼저 순회하고 full PK indexed lookup',()=>{
  const ctx=setup();try{
    const plan=ctx.sqlite.prepare('EXPLAIN QUERY PLAN '+INCREMENTAL_REVIEW_SQL).all('[]','O');
    assert.match(plan[0].detail,/SCAN j/);assert.match(plan[1].detail,/metric_name=\?.*period_type=\?.*period_start=\?.*period_end=\?/);
  }finally{ctx.sqlite.close();}
});
for(const [label,change] of [['다른 accession',f=>{f['us-gaap'].Assets.units.USD[0].accn=oldAccession;}],
 ['빈 facts',()=>({})],['잘못된 배열',f=>{f['us-gaap'].Assets.units.USD={};}]]){
  test(`R6I compact guard: ${label}`,()=>{const facts=factsFor();const changed=change(facts)||facts;
    assert.throws(()=>extractCompactRawRecords(changed,accession));});
}
test('R6I DEI 실제 날짜 및 missing 의미 보존',()=>{
  const records=extractCompactRawRecords(factsFor(),accession);
  assert.ok(records.some(row=>row.metricName==='shares_outstanding'&&row.periodEnd==='2026-02-02'&&row.availability==='available'));
  assert.ok(records.some(row=>row.availability==='missing'&&row.metricValue===null&&row.provenance===null));
});
test('R6I full/compact store 동일 hash/값/출처 결과',async()=>{
 const a=setup(),b=setup();try{const records=extractCompactRawRecords(factsFor(),accession);
   await saveStandardRawMetrics(a.DB,'O',records);await saveStandardRawMetrics(b.DB,'O',records,{preserveExisting:true});
   const clean=rows=>rows.map(({updated_at,created_at,...row})=>row);
   assert.deepEqual(clean(raw(a)),clean(raw(b)));assert.deepEqual(clean(provenance(a)),clean(provenance(b)));
 }finally{a.sqlite.close();b.sqlite.close();}
});
test('R6I 성공/동일 accession shortcut/legacy 숫자 불변',async()=>{
 const ctx=setup();try{assert.equal((await run(ctx)).status,'ready');const before=raw(ctx),prior=state(ctx);ctx.reset();
   const result=await runCompactRawRuntime(ctx.env,'O',accession,()=>{throw Error('재호출 금지');});
   assert.equal(result.status,'unchanged');assert.deepEqual(raw(ctx),before);assert.deepEqual(state(ctx),prior);
   assert.equal(ctx.sqlite.prepare('SELECT revenue FROM financial_metrics').get().revenue,42);
   assert.equal(ctx.batchCalls,0);
 }finally{ctx.sqlite.close();}
});
test('R6I 새 accession 동일값: 값 보존/새 provenance/완료 기록',async()=>{
 const ctx=setup();try{await run(ctx,factsFor(oldAccession),oldAccession);const before=raw(ctx);
   const previous=provenance(ctx).length;assert.equal((await run(ctx)).status,'ready');assert.deepEqual(raw(ctx),before);
   assert.ok(provenance(ctx).length>previous);assert.equal(state(ctx).raw_last_accession,accession);
 }finally{ctx.sqlite.close();}
});
for(const kind of ['NULL 해소','available 정정']) test(`R6I ${kind} 보류: overwrite 금지/출처 append/이전 accession 보존`,async()=>{
 const ctx=setup();try{await run(ctx,factsFor(oldAccession),oldAccession);
   if(kind==='NULL 해소') ctx.sqlite.exec("UPDATE sec_standard_raw_metrics SET availability='missing',metric_value=NULL,source_fingerprint=NULL WHERE metric_name='cash_and_cash_equivalents' AND period_end='2025-12-31'");
   const before=raw(ctx),prov=provenance(ctx).length;
   const result=await run(ctx,factsFor(accession,11));assert.equal(result.status,'pending_review');assert.equal(result.reviewCount,1);
   assert.equal(result.valueCorrections,kind==='available 정정'?1:0);assert.deepEqual(raw(ctx),before);
   assert.ok(provenance(ctx).length>prov);assert.equal(state(ctx).raw_last_accession,oldAccession);
   const after=provenance(ctx);await run(ctx,factsFor(accession,11));assert.deepEqual(provenance(ctx),after);
 }finally{ctx.sqlite.close();}
});
for(const table of ['sec_standard_raw_metrics','sec_standard_raw_provenance']) test(`R6I ${table} failure atomic rollback/retry`,async()=>{
 const ctx=setup();try{ctx.sqlite.exec(`CREATE TRIGGER fail_compact BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'TEST'); END`);
   assert.equal((await run(ctx)).status,'error');assert.equal(raw(ctx).length,0);assert.equal(provenance(ctx).length,0);
   assert.equal(state(ctx).raw_last_accession,null);assert.equal((await run(ctx)).status,'deferred');
   ctx.sqlite.exec("DROP TRIGGER fail_compact; UPDATE sec_raw_runtime SET next_run_at=NULL");assert.equal((await run(ctx)).status,'ready');
 }finally{ctx.sqlite.close();}
});
test('R6I checkpoint 실패도 atomic rollback',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("CREATE TRIGGER fail_compact BEFORE UPDATE ON sec_raw_runtime WHEN NEW.raw_status='ready' BEGIN SELECT RAISE(ABORT,'TEST'); END");
   assert.equal((await run(ctx)).status,'error');assert.equal(raw(ctx).length,0);assert.equal(provenance(ctx).length,0);
 }finally{ctx.sqlite.close();}
});
test('R6I fencing 소유권 상실: 값/출처 저장 차단',async()=>{
 const ctx=setup();try{const batch=ctx.DB.batch;
   ctx.DB.batch=async statements=>{ctx.sqlite.exec("UPDATE sec_raw_runtime SET fence=fence+1,lease_token='other-owner'");return batch(statements);};
   assert.equal((await run(ctx)).status,'error');assert.equal(raw(ctx).length,0);assert.equal(provenance(ctx).length,0);
   assert.equal(state(ctx).lease_token,'other-owner');
 }finally{ctx.sqlite.close();}
});
test('R6I active lease: load/overwrite 없음',async()=>{
 const ctx=setup();try{ctx.sqlite.exec("INSERT INTO sec_raw_runtime(ticker,raw_status,lease_token,lease_until) VALUES ('O','running','owner','2099-01-01T00:00:00Z')");
   assert.equal((await run(ctx)).status,'deferred');assert.equal(raw(ctx).length,0);
 }finally{ctx.sqlite.close();}
});
test('R6I available 후보가 없으면 review SQL 없음',async()=>{
 const ctx=setup();try{ctx.reset();assert.deepEqual(await lookupIncrementalReviews(ctx.DB,'O',[]),[]);assert.equal(ctx.stats.length,0);
 }finally{ctx.sqlite.close();}
});
test('R6I duplicate identity는 transaction 전 차단',async()=>{
 const ctx=setup();try{const records=extractCompactRawRecords(factsFor(),accession);
   await assert.rejects(saveStandardRawMetrics(ctx.DB,'O',[records[0],records[0]],{preserveExisting:true}),/중복/);
   assert.equal(raw(ctx).length,0);assert.equal(ctx.batchCalls,0);
 }finally{ctx.sqlite.close();}
});
test('R6I 완료 registry라도 provenance gap이면 shortcut 금지/복구',async()=>{
 const ctx=setup();try{await run(ctx);ctx.sqlite.exec('DELETE FROM sec_standard_raw_provenance');
   let loaded=0;
   const result=await runCompactRawRuntime(ctx.env,'O',accession,async()=>{loaded++;return {facts:factsFor(),financialPeriods:[]};});
   assert.equal(loaded,1);assert.equal(result.status,'ready');assert.ok(provenance(ctx).length>0);
 }finally{ctx.sqlite.close();}
});
test('R6I 새 accession은 이전 실패 backoff와 독립 처리',async()=>{
 const ctx=setup();try{
   assert.equal((await runCompactRawRuntime(ctx.env,'O',oldAccession,()=>{throw Error('원문 대기');})).status,'error');
   assert.ok(state(ctx).next_run_at);assert.equal((await run(ctx)).status,'ready');assert.equal(state(ctx).next_run_at,null);
 }finally{ctx.sqlite.close();}
});
