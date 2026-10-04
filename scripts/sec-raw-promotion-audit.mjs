import assert from 'node:assert/strict';
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { createRawRuntimeDatabase } from '../tests/helpers/sec-standard-raw-runtime-db.js';
import { addMigrationLedger,testTarget } from '../tests/helpers/sec-raw-promotion-fixtures.js';
import { classificationStatement } from '../worker/src/company-classification.js';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { specializedSnapshot } from './specialized-disposable-db.mjs';
import { rawSourceIdentity } from '../worker/src/sec-raw-message.js';
import { latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { importHistoricalSecRaw } from './sec-raw-historical-import.mjs';
import { promotionHash,sourceBytesHash,currentCheckpoint,assertHistoricalScopeProcessed } from './sec-raw-promotion.mjs';
import { runSecRawDiscovery } from './sec-raw-discovery-runner.mjs';
import consumer from '../worker/src/sec-raw-consumer-entry.js';
import { buildCompactSecRawMessage } from './sec-raw-compact-producer.mjs';
import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';

// 실제 R4 cache와 기존 승인 specialized artifact만 재사용한다. 네트워크는 전역 차단한다.
const originalFetch=globalThis.fetch;let sourceCalls=0;
globalThis.fetch=()=>{sourceCalls++;throw new Error('R8B_AUDIT_NETWORK_FORBIDDEN');};
const ctx=createRawRuntimeDatabase();
const out={phase:'R8B',productionChanged:false,newMigration:false,remoteRehearsal:'NOT EXECUTED',sourceCalls:0};
const tables=['companies','financial_metrics','financial_metric_provenance','company_classification','fundamental_jobs'];
const protectedSnapshot=()=>promotionHash(tables.map(table=>ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const count=table=>ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
try {
  addMigrationLedger(ctx);ctx.DB.identity=async()=>({uuid:testTarget.databaseId,name:testTarget.name});
  const target={...testTarget,allowedDatabaseId:testTarget.databaseId};
  const ledger=JSON.parse(readFileSync('backups/r4/acquisition.json','utf8'));
  assert.equal(ledger.length,10);assert.ok(!ledger.some(row=>row.ticker==='LMT'));
  const metadata=JSON.parse(readFileSync('tests/fixtures/company-classification-metadata.json','utf8')).companies;
  const inputs=new Map(),facts=new Map();
  for(const source of ledger) {
    const sourceBytes=readFileSync(`backups/r4/cache/${source.ticker}.json`);
    assert.equal(sourceBytesHash(sourceBytes),source.sourceSha256);
    const companyFacts=JSON.parse(sourceBytes);assert.equal(Number(companyFacts.cik),source.cik);
    const company={...metadata.find(row=>row.ticker===source.ticker),cik:String(source.cik),name:source.ticker};
    ctx.sqlite.prepare('INSERT INTO companies(ticker,name,cik,sector,industry) VALUES (?,?,?,?,?)')
      .run(source.ticker,company.name,company.cik,company.sector,company.industry);
    await classificationStatement(ctx.DB,company).run();facts.set(source.ticker,companyFacts.facts);
    await syncFinancialsFromSec({DB:ctx.DB,secFacts:facts},source.ticker);
    inputs.set(source.ticker,{companyFacts,sourceBytes});
  }
  assert.equal(count('financial_metrics'),500);
  // LMT 숫자는 로컬 보호 검증용 합성 sentinel이다. 실제 원문을 새로 취득하지 않는다.
  ctx.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('LMT','로컬 보호 검증용 합성 LMT','936468')");
  for(const table of ['financial_metrics','financial_metric_provenance']) {
    const columns=ctx.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
    const query=`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(column=>column==='ticker'?"'LMT'":column).join(',')} FROM ${table} WHERE ticker='AAPL'`;
    ctx.sqlite.exec(query);
  }
  await classificationStatement(ctx.DB,{ticker:'LMT',name:'합성 보호 검증',sector:'Industrials',industry:'Aerospace & Defense'}).run();
  for(const kind of ['profile','financials'])ctx.sqlite.prepare("INSERT INTO fundamental_jobs(ticker,kind,status,details) VALUES ('LMT',?,'ready','SYNTHETIC_SENTINEL')").run(kind);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM financial_metrics WHERE ticker='LMT'").get().n,50);
  const specialized=JSON.parse(readFileSync('backups/p75/artifact.json','utf8'));
  for(const document of specialized.documents)await saveSpecializedMetrics(ctx.DB,{status:'parsed',definitions:document.definitions,records:document.records});
  const specializedBefore=specializedSnapshot(ctx.sqlite);
  assert.deepEqual(specializedBefore.counts,{definitions:14,values:950,provenance:1344});
  assert.equal(specializedBefore.digest,'4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5');
  const before=protectedSnapshot();
  const envelope={approvalVersion:1,datasetVersion:'r8b-local-historical-v1',checkpoint:currentCheckpoint(),
    issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),target:{...testTarget},
    tickers:ledger.map(row=>row.ticker),sourceHashes:{},ciks:{},periodAnchorHashes:{},historicalSourceIdentities:{},historicalAccessions:{},
    expected:{raw:9062,provenance:4615,missing:4422,needsReview:25},retentionExpected:{recovered:285,total:285},
    minimumMigration:22,writeBudget:50000,queue:{accountId:'a'.repeat(32),queueId:'b'.repeat(32),name:'synthetic-r8b-queue'}};
  for(const source of ledger) {
    const input=inputs.get(source.ticker);
    const financialPeriods=ctx.sqlite.prepare("SELECT period_type,fiscal_period_end FROM financial_metrics WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end").all(source.ticker).map(row=>({...row}));
    input.financialPeriods=financialPeriods;
    const accession=latestRawAccession(input.companyFacts.facts);
    envelope.sourceHashes[source.ticker]=source.sourceSha256;envelope.ciks[source.ticker]=String(source.cik);
    envelope.periodAnchorHashes[source.ticker]=promotionHash(financialPeriods);
    envelope.historicalAccessions[source.ticker]=accession;
    envelope.historicalSourceIdentities[source.ticker]=await rawSourceIdentity({version:1,ticker:source.ticker,accession,
      cik:String(source.cik),facts:input.companyFacts.facts,financialPeriods});
  }
  const options={tickers:envelope.tickers,envelope,target,DB:ctx.DB,loadCompanyFacts:async ticker=>inputs.get(ticker)};
  ctx.reset();const dry=await importHistoricalSecRaw(options);
  assert.equal(dry.mode,'dry-run');assert.equal(ctx.stats.reduce((sum,row)=>sum+row.logicalChanges,0),0);
  const verify=await importHistoricalSecRaw({...options,verifyOnly:true});
  assert.equal(verify.receipt.rowsWritten,0);assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));
  const run1=await importHistoricalSecRaw({...options,apply:true,enabled:true,productionApproval:true,
    evidence:{'dry-run':dry.receipt,'verify-only':verify.receipt}});
  assert.ok(run1.results.every(row=>['ready','pending_review'].includes(row.status)));
  const stateCounts=ctx.sqlite.prepare('SELECT availability,COUNT(*) n FROM sec_standard_raw_metrics GROUP BY availability').all();
  assert.equal(count('sec_standard_raw_metrics'),9062);assert.equal(count('sec_standard_raw_provenance'),4615);
  assert.equal(stateCounts.find(row=>row.availability==='missing').n,4422);
  assert.equal(stateCounts.find(row=>row.availability==='needs_review').n,25);
  assert.equal(count('sec_raw_payload_checkpoint'),10);
  const reviewTickers=run1.results.filter(row=>row.status==='pending_review').map(row=>row.ticker).sort();
  assert.deepEqual(reviewTickers,['ABT','O','TSLA']);
  for(const ticker of reviewTickers)assert.equal(ctx.sqlite.prepare('SELECT raw_status FROM sec_raw_runtime WHERE ticker=?').get(ticker).raw_status,'pending');
  const excluded=JSON.parse(readFileSync('backups/r4/inspection.json','utf8')).observations.filter(row=>row.type==='INSTANT_WINDOW_EXCLUSION');
  const unique=new Map(excluded.map(row=>[JSON.stringify([row.ticker,row.metric,row.targetEnd]),row]));
  const recovered=[...unique.values()].filter(row=>ctx.sqlite.prepare("SELECT availability FROM sec_standard_raw_metrics WHERE ticker=? AND metric_name=? AND period_type='instant' AND period_end=?").get(row.ticker,row.metric,row.targetEnd)?.availability==='available').length;
  assert.equal(recovered,285);
  const evidence={'dry-run':(await importHistoricalSecRaw(options)).receipt,'verify-only':(await importHistoricalSecRaw({...options,verifyOnly:true})).receipt};
  ctx.reset();const run2=await importHistoricalSecRaw({...options,apply:true,enabled:true,productionApproval:true,evidence});
  assert.ok(run2.results.every(row=>row.status==='unchanged'));
  const logical=ctx.stats.reduce((sum,row)=>sum+row.logicalChanges,0);
  assert.equal(logical,0);assert.equal(ctx.batchCalls,0);assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));
  await assertHistoricalScopeProcessed(ctx.DB,envelope);
  const run2Writes=Object.fromEntries(['sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_payload_checkpoint','sec_raw_runtime']
    .map(table=>[table,ctx.stats.filter(row=>row.sql.includes(table)).reduce((sum,row)=>sum+row.logicalChanges,0)]));
  assert.equal(protectedSnapshot(),before);assert.deepEqual(specializedSnapshot(ctx.sqlite),specializedBefore);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_metrics WHERE ticker='LMT'").get().n,0);
  await assert.rejects(runSecRawDiscovery({...options,tickers:['LMT'],detectOnly:true}),/SCOPE/);
  const compactInput=JSON.parse(readFileSync('backups/r6f/local-input.json','utf8'));
  const compactResults=[];
  for(const item of compactInput.selected) {
    const message=await buildCompactSecRawMessage({ticker:item.ticker,accession:item.accession,
      companyFacts:inputs.get(item.ticker).companyFacts,financialPeriods:item.financial});
    assert.deepEqual((await validateCompactSecRawMessage(message)).records,item.candidate);
    const db=createRawRuntimeDatabase();try{
      db.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(item.ticker,item.ticker);
      const delivery={body:message,ack(){},retry(){throw Error('R8B_QUEUE_UNEXPECTED_RETRY');}};
      const env={DB:db.DB,SEC_STANDARD_RAW_QUEUE_ENABLED:'true',SEC_STANDARD_RAW_FIELDS_ENABLED:'false'};
      const first=(await consumer.queue({messages:[delivery]},env))[0];assert.equal(first.status,'ready');
      db.reset();const duplicate=(await consumer.queue({messages:[delivery]},env))[0];assert.equal(duplicate.status,'unchanged');
      assert.equal(db.stats.reduce((sum,row)=>sum+row.logicalChanges,0),0);
      compactResults.push({ticker:item.ticker,raw:first.records,available:first.available,semanticEquality:'PASS',duplicateWrites:0,legacyFieldsEnabled:false});
    }finally{db.sqlite.close();}
  }
  out.historical={raw:9062,provenance:4615,missing:4422,needsReview:25,retentionRecovered:recovered,checkpoints:10,
    reviewTickers,run2LogicalChanges:logical,run2Writes,run2DmlStatements:0,verifyOnlyWrites:0};
  out.regression={financialRows:count('financial_metrics'),originalFinancialRows:500,lmtFinancialRows:50,
    protectedUnchanged:true,specialized:specializedBefore,lmtRaw:0,lmtEnqueue:'DENIED',classificationUnchanged:true};
  out.compact=compactResults;out.sourceCalls=sourceCalls;
  assert.equal(sourceCalls,0);mkdirSync('backups/r8b',{recursive:true});
  writeFileSync('backups/r8b/local-audit.json',JSON.stringify(out,null,2));
  console.log(JSON.stringify(out,null,2));
}finally{ctx.sqlite.close();globalThis.fetch=originalFetch;}
