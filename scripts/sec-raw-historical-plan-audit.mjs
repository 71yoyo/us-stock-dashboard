import assert from 'node:assert/strict';
import { readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { createRawRuntimeDatabase } from '../tests/helpers/sec-standard-raw-runtime-db.js';
import { addMigrationLedger,testTarget } from '../tests/helpers/sec-raw-promotion-fixtures.js';
import { loadHistoricalReferenceRuntime,historicalSemanticSnapshot } from '../tests/helpers/sec-raw-historical-reference.js';
import { classificationStatement } from '../worker/src/company-classification.js';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { specializedSnapshot } from './specialized-disposable-db.mjs';
import { rawSourceIdentity } from '../worker/src/sec-raw-message.js';
import { latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';
import { importHistoricalSecRaw } from './sec-raw-historical-import.mjs';
import { promotionHash,sourceBytesHash,currentCheckpoint } from './sec-raw-promotion.mjs';

// 승인 원문은 기존 ignored cache에서만 읽는다. 없는 경우 다운로드/추정 PASS 없이 중단한다.
const required=['backups/r4/acquisition.json','backups/r4/inspection.json','backups/p75/artifact.json'];
if(required.some(file=>!existsSync(file))){console.log(JSON.stringify({status:'NOT VERIFIED',reason:'기존 cache 미확보'}));process.exitCode=1;}
else await audit();

async function audit(){
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('R8I_FIX_NETWORK_FORBIDDEN');};
  const ctx=createRawRuntimeDatabase(),reference=createRawRuntimeDatabase();
  const count=table=>ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const protectedTables=['companies','financial_metrics','financial_metric_provenance','company_classification','fundamental_jobs'];
  const protectedDigest=()=>promotionHash(protectedTables.map(table=>ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  try{
    addMigrationLedger(ctx);ctx.DB.identity=async()=>({uuid:testTarget.databaseId,name:testTarget.name});
    const ledger=JSON.parse(readFileSync(required[0],'utf8'));
    assert.equal(ledger.length,10);assert.ok(!ledger.some(row=>row.ticker==='LMT'));
    if(ledger.some(row=>!existsSync(`backups/r4/cache/${row.ticker}.json`))){
      console.log(JSON.stringify({status:'NOT VERIFIED',reason:'기존 10종목 cache 미확보'}));process.exitCode=1;return;
    }
    const metadata=JSON.parse(readFileSync('tests/fixtures/company-classification-metadata.json','utf8')).companies;
    const inputs=new Map(),facts=new Map();
    for(const source of ledger){
      const sourceBytes=readFileSync(`backups/r4/cache/${source.ticker}.json`);
      assert.equal(sourceBytesHash(sourceBytes),source.sourceSha256);
      const companyFacts=JSON.parse(sourceBytes);assert.equal(Number(companyFacts.cik),source.cik);
      const company={...metadata.find(row=>row.ticker===source.ticker),ticker:source.ticker,cik:String(source.cik),name:source.ticker};
      ctx.sqlite.prepare('INSERT INTO companies(ticker,name,cik,sector,industry) VALUES (?,?,?,?,?)')
        .run(company.ticker,company.name,company.cik,company.sector,company.industry);
      reference.sqlite.prepare('INSERT INTO companies(ticker,name,cik) VALUES (?,?,?)').run(company.ticker,company.name,company.cik);
      await classificationStatement(ctx.DB,company).run();facts.set(source.ticker,companyFacts.facts);
      await syncFinancialsFromSec({DB:ctx.DB,secFacts:facts},source.ticker);
      const financialPeriods=ctx.sqlite.prepare("SELECT period_type,fiscal_period_end FROM financial_metrics WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end").all(source.ticker).map(row=>({...row}));
      inputs.set(source.ticker,{companyFacts,sourceBytes,financialPeriods});
    }
    assert.equal(count('financial_metrics'),500);
    // 실제 LMT 원문/API를 추가하지 않고 11-company 범위 밖 보호 sentinel만 둔다.
    ctx.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('LMT','합성 보호 sentinel','936468')");
    for(const table of ['financial_metrics','financial_metric_provenance']){
      const columns=ctx.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
      ctx.sqlite.exec(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(column=>column==='ticker'?"'LMT'":column).join(',')} FROM ${table} WHERE ticker='AAPL'`);
    }
    await classificationStatement(ctx.DB,{ticker:'LMT',name:'합성 보호 sentinel',sector:'Industrials',industry:'Aerospace & Defense'}).run();
    const artifact=JSON.parse(readFileSync(required[2],'utf8'));
    for(const document of artifact.documents)await saveSpecializedMetrics(ctx.DB,{status:'parsed',definitions:document.definitions,records:document.records});
    const specializedBefore=specializedSnapshot(ctx.sqlite),before=protectedDigest();
    assert.deepEqual(specializedBefore.counts,{definitions:14,values:950,provenance:1344});
    assert.equal(specializedBefore.digest,'4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5');
    const envelope={approvalVersion:1,datasetVersion:'synthetic-r8i-fix-v1',checkpoint:currentCheckpoint(),
      issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),target:{...testTarget},
      tickers:ledger.map(row=>row.ticker),sourceHashes:{},ciks:{},periodAnchorHashes:{},historicalSourceIdentities:{},historicalAccessions:{},
      expected:{raw:9062,provenance:4615,missing:4422,needsReview:25},retentionExpected:{recovered:285,total:285},
      minimumMigration:22,writeBudget:50000,queue:{accountId:'a'.repeat(32),queueId:'b'.repeat(32),name:'synthetic-r8i-fix'}};
    for(const source of ledger){
      const input=inputs.get(source.ticker),accession=latestRawAccession(input.companyFacts.facts);
      envelope.sourceHashes[source.ticker]=source.sourceSha256;envelope.ciks[source.ticker]=String(source.cik);
      envelope.periodAnchorHashes[source.ticker]=promotionHash(input.financialPeriods);
      envelope.historicalAccessions[source.ticker]=accession;
      envelope.historicalSourceIdentities[source.ticker]=await rawSourceIdentity({version:1,ticker:source.ticker,accession,
        cik:String(source.cik),facts:input.companyFacts.facts,financialPeriods:input.financialPeriods});
    }
    const options={tickers:envelope.tickers,envelope,target:{...testTarget,allowedDatabaseId:testTarget.databaseId},DB:ctx.DB,loadCompanyFacts:async ticker=>inputs.get(ticker)};
    ctx.reset();const dry=await importHistoricalSecRaw(options);
    assert.equal(dry.mode,'dry-run');assert.equal(dry.summary.stateVerified,true);
    assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));assert.equal(ctx.batchCalls,0);
    assert.equal(ctx.stats.reduce((n,row)=>n+row.logicalChanges,0),0);
    const exact={NVDA:[974,404,570,0],AAPL:[977,443,534,0],MSFT:[969,405,564,0],JPM:[769,356,413,0],
      O:[953,709,238,6],ABBV:[983,493,490,0],ABT:[780,437,338,5],AMZN:[969,484,485,0],GOOGL:[714,308,406,0],TSLA:[974,576,384,14]};
    for(const p of dry.perTickerPlans){
      assert.deepEqual([p.counts.raw,p.counts.provenance,p.counts.missing,p.counts.needsReview],exact[p.ticker]);
      assert.equal(p.actions.raw.insert,p.counts.raw);assert.equal(p.actions.provenance.append,p.counts.provenance);
      assert.equal(p.actions.checkpoint.action,'insert');assert.equal(p.sameCompletedSourceShortcut,false);
    }
    assert.equal(dry.summary.plannedSourceCheckpoints,10);assert.equal(dry.summary.needsReview,25);
    assert.equal(dry.summary.estimatedWrites,43031);assert.ok(dry.summary.estimatedWrites<=50000);
    assert.equal(dry.summary.estimatedSemanticWrites,13737);
    const verify=await importHistoricalSecRaw({...options,verifyOnly:true});
    ctx.reset();const run1=await importHistoricalSecRaw({...options,apply:true,enabled:true,productionApproval:true,
      evidence:{'dry-run':dry.receipt,'verify-only':verify.receipt}});
    assert.ok(run1.results.every(row=>['ready','pending_review'].includes(row.status)));
    const sqliteChanges=ctx.stats.reduce((n,row)=>n+row.logicalChanges,0);
    assert.equal(sqliteChanges,dry.summary.estimatedSemanticWrites);
    const oldRuntime=await loadHistoricalReferenceRuntime();
    for(const ticker of envelope.tickers){
      const input=inputs.get(ticker),records=extractStandardRawMetrics(input.companyFacts.facts,{financialPeriods:input.financialPeriods});
      const old=await oldRuntime({DB:reference.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},ticker,envelope.historicalAccessions[ticker],async()=>records,
        {sourceIdentity:envelope.historicalSourceIdentities[ticker],channel:'historical',strictReview:true,processingCheckpoint:true});
      const next=run1.results.find(row=>row.ticker===ticker);assert.equal(next.status,old.status);
    }
    assert.deepEqual(historicalSemanticSnapshot(ctx.sqlite),historicalSemanticSnapshot(reference.sqlite));
    assert.equal(count('sec_standard_raw_metrics'),9062);assert.equal(count('sec_standard_raw_provenance'),4615);
    assert.equal(count('sec_raw_payload_checkpoint'),10);
    const exclusions=JSON.parse(readFileSync(required[1],'utf8')).observations.filter(row=>row.type==='INSTANT_WINDOW_EXCLUSION');
    const unique=new Map(exclusions.map(row=>[JSON.stringify([row.ticker,row.metric,row.targetEnd]),row]));
    const recovered=[...unique.values()].filter(row=>ctx.sqlite.prepare("SELECT availability FROM sec_standard_raw_metrics WHERE ticker=? AND metric_name=? AND period_type='instant' AND period_end=?").get(row.ticker,row.metric,row.targetEnd)?.availability==='available').length;
    assert.equal(recovered,285);
    const dei=ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_provenance WHERE sec_tag='EntityCommonStockSharesOutstanding' AND period_type='instant' AND period_start='' AND period_end=source_end").get().n;
    assert.equal(dei,386);
    const run2Dry=await importHistoricalSecRaw(options);
    assert.equal(run2Dry.summary.estimatedSemanticWrites,0);assert.equal(run2Dry.summary.checkpointMutations,0);
    for(const p of run2Dry.perTickerPlans){assert.equal(p.sameCompletedSourceShortcut,true);assert.equal(p.estimatedSemanticWrites,0);}
    const run2Verify=await importHistoricalSecRaw({...options,verifyOnly:true});
    ctx.reset();const run2=await importHistoricalSecRaw({...options,apply:true,enabled:true,productionApproval:true,
      evidence:{'dry-run':run2Dry.receipt,'verify-only':run2Verify.receipt}});
    assert.ok(run2.results.every(row=>row.status==='unchanged'));
    assert.equal(ctx.stats.reduce((n,row)=>n+row.logicalChanges,0),0);assert.equal(ctx.batchCalls,0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_runtime WHERE lease_token IS NOT NULL OR lease_until IS NOT NULL OR next_run_at IS NOT NULL').get().n,0);
    assert.equal(protectedDigest(),before);assert.deepEqual(specializedSnapshot(ctx.sqlite),specializedBefore);
    assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_metrics WHERE ticker='LMT'").get().n,0);
    const duplicates=ctx.sqlite.prepare('SELECT COUNT(*) n FROM (SELECT ticker,metric_name,period_type,period_start,period_end,COUNT(*) n FROM sec_standard_raw_metrics GROUP BY 1,2,3,4,5 HAVING n>1)').get().n;
    const orphans=ctx.sqlite.prepare('PRAGMA foreign_key_check').all().length;assert.equal(duplicates,0);assert.equal(orphans,0);assert.equal(calls,0);
    const result={phase:'R8I-FIX',status:'PASS',sourceCalls:calls,productionChanged:false,referenceCheckpoint:'607f93f2d7d7a2dbdb5684cf63db77987fdaf4be',
      dryRun:{writes:0,run:0,batch:0,summary:dry.summary,perTickerPlans:dry.perTickerPlans},
      applyParity:'PASS',run1:{sqliteLogicalChanges:sqliteChanges,actualD1BilledRowsWritten:'NOT MEASURED',retentionRecovered:recovered,deiActualDates:dei},
      run2:{summary:run2Dry.summary,rawMutations:0,provenanceMutations:0,checkpointMutations:0,runtimeLogicalChanges:0},
      regression:{approvedFinancial:500,protectedFinancial:550,companies:11,specialized:specializedBefore,protectedUnchanged:true,duplicates,orphans},
      newMigration:false,existingEnvelopeModified:false};
    mkdirSync('backups/r8i-fix',{recursive:true});writeFileSync('backups/r8i-fix/local-audit.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }finally{ctx.sqlite.close();reference.sqlite.close();globalThis.fetch=originalFetch;}
}
