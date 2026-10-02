import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { extractStandardRawMetrics, STANDARD_RAW_METRICS } from '../worker/src/sec-standard-raw.js';
import { saveStandardRawMetrics, queryStandardRawMetrics } from '../worker/src/sec-standard-raw-store.js';
import { classificationStatement } from '../worker/src/company-classification.js';
import { createMetricTestDatabase } from '../tests/helpers/specialized-metrics-db.js';
import { companies, syntheticCompanyFacts, oR2Facts, oR2 } from '../tests/helpers/sec-standard-raw-fixtures.js';
import { loadHistoricalCache } from './realty-income-p6-input.mjs';
import { backfillHistorical } from './specialized-historical-backfill.mjs';
import { specializedSnapshot, stableData } from './specialized-disposable-db.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(stableData(value))).digest('hex');
const snapshot = (sqlite, table, order) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const numericRows = sqlite => sqlite.prepare(`SELECT ticker,period_type,fiscal_period_end,
  revenue,operating_income,net_income,eps,free_cash_flow,roe,roic,gross_margin,operating_margin,
  peg_ratio,pe_ratio,ps_ratio,fiscal_year,fiscal_period,period_start FROM financial_metrics
  ORDER BY ticker,period_type,fiscal_period_end`).all();

/** 시점 값의 연간/분기 coverage는 financial 기간의 정확한 end와 instant를 join해 집계한다. */
function coverage(sqlite, ticker) {
  return Object.fromEntries(Object.keys(STANDARD_RAW_METRICS).map(name => {
    const point = STANDARD_RAW_METRICS[name].kind === 'point_in_time';
    const periods = {};
    for (const type of ['annual','quarterly']) {
      const records = point ? sqlite.prepare(`SELECT f.fiscal_period_end,
        r.metric_value FROM financial_metrics f LEFT JOIN sec_standard_raw_metrics r
          ON r.ticker=f.ticker AND r.period_end=f.fiscal_period_end
          AND r.metric_name=? AND r.period_type='instant'
        WHERE f.ticker=? AND f.period_type=? ORDER BY f.fiscal_period_end`).all(name,ticker,type)
        : sqlite.prepare(`SELECT metric_value FROM sec_standard_raw_metrics
          WHERE ticker=? AND metric_name=? AND period_type=?`).all(ticker,name,type);
      periods[type] = { periods: records.length, available: records.filter(row=>row.metric_value!==null).length,
        null: records.filter(row=>row.metric_value===null).length };
    }
    return [name,periods];
  }));
}

/** 설정/credential/네트워크를 받지 않고 독립 메모리 DB에서만 검증한다. */
export async function runStandardRawAudit(cachePath = null) {
  const database = createMetricTestDatabase(), {sqlite,DB} = database;
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  globalThis.fetch = () => { forbiddenCalls++; throw new Error('R3 로컬 audit에서 외부 API 호출은 금지됩니다.'); };
  try {
    const fixtures = new Map();
    for (const company of companies) {
      sqlite.prepare('INSERT INTO companies(ticker,name,sector,industry) VALUES (?,?,?,?)')
        .run(company.ticker,company.ticker,company.sector,company.industry);
      await classificationStatement(DB,company).run();
      fixtures.set(company.ticker,syntheticCompanyFacts({ missingMetrics: company.ticker === 'JPM'
        ? ['interest_expense','depreciation_and_amortization'] : [] }));
      await syncFinancialsFromSec({DB,secFacts:fixtures},company.ticker);
    }
    const beforeRows = numericRows(sqlite);
    assert.equal(beforeRows.length,500);
    const numericBefore=digest(beforeRows);
    const classificationBefore=digest(snapshot(sqlite,'company_classification','ticker'));
    const oldProvenanceBefore=digest(snapshot(sqlite,'financial_metric_provenance','ticker,period_type,fiscal_period_end,metric_name'));
    let specializedBefore=null;
    if(cachePath){
      const input=loadHistoricalCache(cachePath);
      await backfillHistorical({...database,disposable:true,path:':memory:'},input.rows);
      specializedBefore=specializedSnapshot(sqlite);
      assert.deepEqual(specializedBefore.counts,{definitions:14,values:950,provenance:1344});
    }
    for(const company of companies)await syncFinancialsFromSec({DB,secFacts:fixtures,
      SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},company.ticker);
    assert.equal(digest(numericRows(sqlite)),numericBefore);
    assert.equal(digest(snapshot(sqlite,'company_classification','ticker')),classificationBefore);
    assert.equal(digest(snapshot(sqlite,'financial_metric_provenance','ticker,period_type,fiscal_period_end,metric_name')),oldProvenanceBefore);
    if(specializedBefore)assert.deepEqual(specializedSnapshot(sqlite),specializedBefore);
    const syntheticCoverage=Object.fromEntries(companies.map(company=>[company.ticker,coverage(sqlite,company.ticker)]));
    const r2Database=createMetricTestDatabase();
    let actualO;
    try {
      r2Database.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','R2 diagnostic fixture')");
      const records=extractStandardRawMetrics(oR2Facts(),{minimumYear:2016});
      await saveStandardRawMetrics(r2Database.DB,'O',records);
      actualO={};
      for(const type of ['instant','annual','quarterly','ytd']){
        actualO[type]=(await queryStandardRawMetrics(r2Database.DB,'O',type)).map(row=>({
          metric:row.metric_name,start:row.period_start,end:row.period_end,value:row.metric_value,
          availability:row.availability,tag:row.sec_tag,calculation:row.calculation_type }));
      }
      for(const [name,value] of Object.entries(oR2.expectedDerived)){
        assert.equal(actualO.annual.find(row=>row.metric===name).value,value);
      }
      const before=digest(snapshot(r2Database.sqlite,'sec_standard_raw_metrics','metric_name,period_type,period_start,period_end'));
      const writesBefore=r2Database.sqlite.prepare('SELECT total_changes() n').get().n;
      await saveStandardRawMetrics(r2Database.DB,'O',records);
      assert.equal(r2Database.sqlite.prepare('SELECT total_changes() n').get().n,writesBefore);
      assert.equal(digest(snapshot(r2Database.sqlite,'sec_standard_raw_metrics','metric_name,period_type,period_start,period_end')),before);
    } finally {r2Database.sqlite.close();}
    assert.equal(forbiddenCalls,0);
    // UI/public route/분류/specialized/기존 숫자 계산 불변은 Git diff로도 확인한다.
    return { scope:'로컬 폐기 가능한 메모리 SQLite만 사용', sourceArchitecture:'SEC 중심',
      apiCalls:{SEC:0,BQ:0,FMP:0,Massive:0},
      migration:{name:'0020_sec_standard_raw_metrics.sql',additiveOnly:true,productionApplied:false},
      rawFields:Object.keys(STANDARD_RAW_METRICS), marketCapStored:false,
      evidence:{o:oR2.evidence,tenCompanyActualCoverage:'NOT VERIFIED — 기존 CompanyFacts 원문 snapshot 미보유',
        syntheticCoverageLabel:'합성 10년/40분기 검증; 실제 회사 coverage가 아님'},
      syntheticCoverage,actualO,
      regression:{financialRows:500,numericDigestBefore:numericBefore,numericDigestAfter:digest(numericRows(sqlite)),
        financialNumericUnchanged:true,classificationUnchanged:true,oldProvenanceUnchanged:true,
        specialized:specializedBefore||'NOT VERIFIED — cache 인자 필요'},
      idempotency:{secondRunRowsWritten:0},
      production:{migration:false,write:false,backfill:false,workerDeploy:false,pagesDeploy:false,commit:false,push:false} };
  } finally {globalThis.fetch=originalFetch;sqlite.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  assert.ok(!args.length||(args.length===2&&args[0]==='--read-only-cache'),'허용 인자: --read-only-cache <기존 repo 밖 cache>');
  console.log(JSON.stringify(await runStandardRawAudit(args[1]||null),null,2));
}
