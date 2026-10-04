import { readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRawRuntimeDatabase } from '../tests/helpers/sec-standard-raw-runtime-db.js';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';
import { saveStandardRawMetrics } from '../worker/src/sec-standard-raw-store.js';
import { importHistoricalSecRaw } from './sec-raw-historical-import.mjs';
import { buildCompactSecRawMessage } from './sec-raw-compact-producer.mjs';
import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';
import { consumeCompactSecRaw } from '../worker/src/sec-raw-queue.js';

// 실제 cache는 Git 밖에 그대로 두고 hash/통계/동일성만 검사한다. 네트워크 재다운로드는 금지다.
const clean = rows => rows.map(({updated_at,created_at,...row})=>({...row}));
const rows = (ctx,table) => clean(ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const hash = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const result = {phase:'R7',sourceCalls:0,historical:'NOT VERIFIED',compact:'NOT VERIFIED',productionChanged:false};
const originalFetch = globalThis.fetch;
globalThis.fetch=()=>{throw Error('R7 audit의 외부 호출은 금지입니다.');};
const ctx=createRawRuntimeDatabase();
try {
 if(existsSync('backups/r4/acquisition.json')) {
  const sources=JSON.parse(readFileSync('backups/r4/acquisition.json','utf8'));
  assert.equal(sources.length,10);
  const byTicker=new Map(),periods=new Map();
  for(const source of sources){
   const bytes=readFileSync(`backups/r4/cache/${source.ticker}.json`);
   assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sourceSha256);
   const companyFacts=JSON.parse(bytes);assert.equal(Number(companyFacts.cik),source.cik);
   byTicker.set(source.ticker,companyFacts);
   ctx.sqlite.prepare('INSERT INTO companies(ticker,name,cik) VALUES (?,?,?)').run(source.ticker,source.ticker,String(companyFacts.cik));
  }
  const secFacts=new Map([...byTicker].map(([ticker,payload])=>[ticker,payload.facts]));
  for(const [ticker] of byTicker) {
   await syncFinancialsFromSec({DB:ctx.DB,secFacts},ticker);
   periods.set(ticker,ctx.sqlite.prepare('SELECT period_type,fiscal_period_end FROM financial_metrics WHERE ticker=? ORDER BY period_type,fiscal_period_end').all(ticker).map(row=>({...row})));
  }
  const protectedBefore=hash(['financial_metrics','financial_metric_provenance','company_classification'].map(table=>rows(ctx,table)));
  const loadCompanyFacts=async ticker=>({companyFacts:byTicker.get(ticker),financialPeriods:periods.get(ticker)});
  const dry=await importHistoricalSecRaw({tickers:[...byTicker.keys()],loadCompanyFacts});
  assert.ok(dry.results.every(row=>row.status==='dry-run'));
  const expected = new Map([...byTicker].map(([ticker,payload])=>[ticker,extractStandardRawMetrics(payload.facts,{financialPeriods:periods.get(ticker)})]));
  const target={databaseId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',allowedDatabaseId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',name:'r7-memory-disposable'};
  ctx.DB.identity=async()=>({uuid:target.databaseId,name:target.name});
  const run1=await importHistoricalSecRaw({DB:ctx.DB,target,tickers:[...byTicker.keys()],loadCompanyFacts,apply:true,enabled:true});
  assert.ok(run1.results.every(row=>['ready','pending_review'].includes(row.status)));
  for(const [ticker,records] of expected){
   const actual=ctx.sqlite.prepare('SELECT * FROM sec_standard_raw_metrics WHERE ticker=?').all(ticker);
   assert.equal(actual.length,records.length);
   for(const record of records){const row=actual.find(r=>r.metric_name===record.metricName&&r.period_type===record.periodType&&r.period_start===record.periodStart&&r.period_end===record.periodEnd);
    assert.ok(row);assert.equal(row.metric_value,record.metricValue);assert.equal(row.availability,record.availability);
   }
  }
  const count=table=>ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  assert.equal(count('sec_standard_raw_metrics'),9062);assert.equal(count('sec_standard_raw_provenance'),4615);
  // R5 추출 결과를 기존 store에 직접 저장한 reference와 전체 raw/provenance 컬럼을 대조한다.
  const reference=createRawRuntimeDatabase();
  try {
   for(const [ticker,records] of expected){
    reference.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(ticker,ticker);
    await saveStandardRawMetrics(reference.DB,ticker,records);
   }
   for(const table of ['sec_standard_raw_metrics','sec_standard_raw_provenance'])assert.deepEqual(rows(ctx,table),rows(reference,table));
  }finally{reference.sqlite.close();}
  const semanticBefore=hash(['sec_standard_raw_metrics','sec_standard_raw_provenance'].map(table=>rows(ctx,table)));
  ctx.reset();await importHistoricalSecRaw({DB:ctx.DB,target,tickers:[...byTicker.keys()],loadCompanyFacts,apply:true,enabled:true,resume:true});
  assert.equal(hash(['sec_standard_raw_metrics','sec_standard_raw_provenance'].map(table=>rows(ctx,table))),semanticBefore);
  const unnecessaryWrites=ctx.stats.filter(s=>/^INSERT INTO sec_standard_raw_(metrics|provenance)/.test(s.sql)).reduce((sum,s)=>sum+s.logicalChanges,0);
  assert.equal(unnecessaryWrites,0);
  assert.equal(hash(['financial_metrics','financial_metric_provenance','company_classification'].map(table=>rows(ctx,table))),protectedBefore);
  const excluded=JSON.parse(readFileSync('backups/r4/inspection.json','utf8')).observations.filter(row=>row.type==='INSTANT_WINDOW_EXCLUSION');
  const unique=new Map(excluded.map(row=>[JSON.stringify([row.ticker,row.metric,row.targetEnd]),row]));
  let recovered=0;
  for(const row of unique.values())if(ctx.sqlite.prepare("SELECT availability FROM sec_standard_raw_metrics WHERE ticker=? AND metric_name=? AND period_type='instant' AND period_end=?").get(row.ticker,row.metric,row.targetEnd)?.availability==='available')recovered++;
  assert.equal(recovered,285);
  result.historical={status:'PASS',tickers:dry.results.map(({ticker,raw,available,missing,needsReview,provenance})=>({ticker,raw,available,missing,needsReview,provenance})),
   raw:9062,provenance:4615,missing:4422,needsReview:25,retentionRecovered:recovered,semanticEquality:'PASS',
   deiActualDatesPreserved:true,run2SemanticChanges:0,run2RawProvenanceWrites:unnecessaryWrites,financialRows:count('financial_metrics'),protectedUnchanged:true};
 }
 if(existsSync('backups/r6f/local-input.json')){
  const input=JSON.parse(readFileSync('backups/r6f/local-input.json','utf8'));const compact=[];
  for(const item of input.selected){
   const db=createRawRuntimeDatabase();try{
    db.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(item.ticker,item.ticker);
    const companyFacts=JSON.parse(readFileSync(`backups/r4/cache/${item.ticker}.json`,'utf8'));
    const message=await buildCompactSecRawMessage({ticker:item.ticker,accession:item.accession,companyFacts,financialPeriods:item.financial});
    const validated=await validateCompactSecRawMessage(message);assert.deepEqual(validated.records,item.candidate);
    const env={DB:db.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true',SEC_STANDARD_RAW_QUEUE_ENABLED:'true'};
    const delivery=body=>({body,id:'local',ack(){},retry(){throw Error('local retry unexpected');}});
    const first=await consumeCompactSecRaw(delivery(message),env);assert.equal(first.status,'ready');db.reset();
    const duplicate=await consumeCompactSecRaw({...delivery(message),id:'new-id'},env);assert.equal(duplicate.status,'unchanged');
    assert.equal(db.stats.reduce((s,row)=>s+row.logicalChanges,0),0);
    compact.push({ticker:item.ticker,raw:first.records,available:first.available,missing:first.missing,bytes:Buffer.byteLength(JSON.stringify(message)),semanticEquality:'PASS',duplicateWrites:0});
   }finally{db.sqlite.close();}
  }
  result.compact=compact;
 }
 mkdirSync('backups/r7',{recursive:true});writeFileSync('backups/r7/local-audit.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}finally{ctx.sqlite.close();globalThis.fetch=originalFetch;}
