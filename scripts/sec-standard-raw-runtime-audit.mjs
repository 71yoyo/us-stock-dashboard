import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { syncFinancialsFromSec, syncStandardRawFromSec } from '../worker/src/fmp-sync.js';
import { assertRawRuntimeSchema, latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { STANDARD_RAW_METRICS } from '../worker/src/sec-standard-raw.js';
import { classificationStatement } from '../worker/src/company-classification.js';
import { createRawRuntimeDatabase } from '../tests/helpers/sec-standard-raw-runtime-db.js';
import { stableData, specializedSnapshot } from './specialized-disposable-db.mjs';
import { loadHistoricalCache } from './realty-income-p6-input.mjs';
import { backfillHistorical } from './specialized-historical-backfill.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(stableData(value))).digest('hex');
const numericRows = sqlite => sqlite.prepare(`SELECT ticker,period_type,fiscal_period_end,revenue,operating_income,
  net_income,eps,free_cash_flow,roe,roic,gross_margin,operating_margin,peg_ratio,pe_ratio,ps_ratio,
  fiscal_year,fiscal_period,period_start FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end`).all();
const tableRows = (sqlite, table, order = 'ticker') => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const rawSnapshot = sqlite => ({ values: tableRows(sqlite, 'sec_standard_raw_metrics', 'ticker,metric_name,period_type,period_start,period_end'),
  provenance: tableRows(sqlite, 'sec_standard_raw_provenance', 'ticker,metric_name,period_type,period_start,period_end,source_fingerprint') });
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

/** 두 coverage 분모를 구분한다. 시점은 financial 100FY/400Q exact end, 기간 합계는 raw 실제 start/end다. */
function coverage(sqlite, ticker = null) {
  return Object.fromEntries(Object.entries(STANDARD_RAW_METRICS).map(([metric, definition]) => [metric,
    Object.fromEntries(['annual','quarterly','ytd','instant'].map(type => {
      const pointJoin = definition.kind === 'point_in_time' && ['annual','quarterly'].includes(type);
      const rows = pointJoin ? sqlite.prepare(`SELECT r.availability FROM financial_metrics f
        LEFT JOIN sec_standard_raw_metrics r ON r.ticker=f.ticker AND r.metric_name=?
        AND r.period_type='instant' AND r.period_end=f.fiscal_period_end WHERE f.period_type=?
        AND (? IS NULL OR f.ticker=?)`).all(metric, type, ticker, ticker)
        : sqlite.prepare(`SELECT availability FROM sec_standard_raw_metrics WHERE metric_name=? AND period_type=?
          AND (? IS NULL OR ticker=?)`).all(metric, type, ticker, ticker);
      return [type, { total: rows.length, available: rows.filter(r => r.availability === 'available').length,
        missing: rows.filter(r => !r.availability || r.availability === 'missing').length,
        needsReview: rows.filter(r => r.availability === 'needs_review').length }];
    }))]));
}

function summarizeCost(stats) {
  return { statements: stats.length,
    SELECT: stats.filter(s => /^SELECT/i.test(s.sql)).length,
    INSERT: stats.filter(s => /^INSERT/i.test(s.sql)).length,
    UPDATE: stats.filter(s => /^UPDATE/i.test(s.sql)).length,
    DELETE: stats.filter(s => /^DELETE/i.test(s.sql)).length,
    logicalChanges: stats.reduce((sum, s) => sum + s.logicalChanges, 0),
    maximumBindBytes: Math.max(0, ...stats.map(s => s.bindBytes)),
    maximumBindings: Math.max(0, ...stats.map(s => s.bindings)),
    maximumSqlBytes: Math.max(0, ...stats.map(s => Buffer.byteLength(s.sql))),
    d1BilledRowsRead: 'NOT VERIFIED', d1BilledRowsWritten: 'NOT VERIFIED' };
}

/**
 * 실제 R4 원문/결과/SQLite snapshot을 읽기 전용으로 재사용한다.
 * 모든 SEC/BQ/FMP/Massive/Cloudflare 요청을 차단하며 새 DB는 메모리에만 만든다.
 * 캐시가 없거나 hash가 다르면 PASS 대신 즉시 중단한다.
 */
export async function runRawRuntimeAudit({ r4Directory = resolve('backups/r4'), historicalCache = null } = {}) {
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  globalThis.fetch = () => { forbiddenCalls++; throw Error('R5 audit의 외부 호출은 금지입니다.'); };
  const db = createRawRuntimeDatabase(), { sqlite, DB } = db;
  let baselineDB;
  try {
    const read = name => JSON.parse(readFileSync(join(r4Directory, name), 'utf8'));
    const acquisition = read('acquisition.json'), baseline = read('results.json'), inspection = read('inspection.json');
    assert.equal(acquisition.length, 10);
    const meta = JSON.parse(readFileSync(new URL('../tests/fixtures/company-classification-metadata.json', import.meta.url))).companies;
    const facts = new Map();
    for (const source of acquisition) {
      const bytes = readFileSync(join(r4Directory, 'cache', source.ticker + '.json'));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sourceSha256);
      const payload = JSON.parse(bytes); assert.equal(Number(payload.cik), source.cik);
      facts.set(source.ticker, payload.facts);
      const company = { ...meta.find(c => c.ticker === source.ticker), name: payload.entityName, cik: String(payload.cik) };
      sqlite.prepare('INSERT INTO companies(ticker,name,cik,sector,industry) VALUES (?,?,?,?,?)')
        .run(source.ticker, company.name, company.cik, company.sector, company.industry);
      await classificationStatement(DB, company).run();
      await syncFinancialsFromSec({ DB, secFacts: facts }, source.ticker);
    }
    const protectedBefore = { numeric: digest(numericRows(sqlite)), financial: digest(tableRows(sqlite, 'financial_metrics', 'ticker,period_type,fiscal_period_end')),
      classification: digest(tableRows(sqlite, 'company_classification')),
      provenance: digest(tableRows(sqlite, 'financial_metric_provenance', 'ticker,period_type,fiscal_period_end,metric_name')) };
    assert.equal(numericRows(sqlite).length, 500);
    assert.equal(protectedBefore.numeric, baseline.regression.financialDigest);
    let specialized = { status: 'NOT VERIFIED — 기존 외부 historical cache 인자 필요' };
    if (historicalCache) {
      const input = loadHistoricalCache(historicalCache);
      await backfillHistorical({ ...db, disposable: true, path: ':memory:' }, input.rows);
      specialized = specializedSnapshot(sqlite);
      assert.deepEqual(specialized.counts, { definitions: 14, values: 950, provenance: 1344 });
      assert.equal(specialized.digest, '4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5');
    }
    const baselinePath = baseline.storageAfter.path.replace(/^\/([A-Z]:)/i, '$1');
    if (!existsSync(baselinePath)) throw Error('R4 실제 SQLite baseline이 없습니다.');
    baselineDB = new DatabaseSync(baselinePath, { readOnly: true });
    assert.equal(count(baselineDB, 'sec_standard_raw_metrics'), 8187);
    const beforeCoverage = coverage(baselineDB);
    const beforePages = sqlite.prepare('PRAGMA page_count').get().page_count;
    db.reset();
    await assertRawRuntimeSchema(DB);
    const env = { DB, secFacts: facts, SEC_STANDARD_RAW_FIELDS_ENABLED: 'true' };
    const perTickerCost = {};
    for (const [ticker, payload] of facts) {
      const start = db.stats.length;
      const result = await syncStandardRawFromSec(env, ticker, latestRawAccession(payload));
      assert.equal(result.status, 'ready', ticker);
      perTickerCost[ticker] = summarizeCost(db.stats.slice(start));
    }
    const run1Cost = summarizeCost(db.stats);
    run1Cost.bindingCalls = { individual: db.singleCalls, batch: db.batchCalls };
    const registryRun1Cost = summarizeCost(db.stats.filter(s => /sec_raw_runtime/.test(s.sql) && !/sqlite_master/.test(s.sql)));
    // raw-only와 legacy 포함 실행의 비용을 별도 DB에서 실제로 구분한다. 운영 invocation quota로 환산하지 않는다.
    const fullDb = createRawRuntimeDatabase();
    let fullSyncCost;
    try {
      const previousResults = new Map();
      for (const [ticker] of facts) {
        fullDb.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(ticker, ticker);
        previousResults.set(ticker, await syncFinancialsFromSec({ DB: fullDb.DB, secFacts: facts }, ticker));
      }
      const beforeNumeric = digest(numericRows(fullDb.sqlite)); fullDb.reset();
      for (const [ticker] of facts) {
        const result = await syncFinancialsFromSec({ DB: fullDb.DB, secFacts: facts,
          SEC_STANDARD_RAW_FIELDS_ENABLED: 'true' }, ticker);
        assert.deepEqual(result, previousResults.get(ticker));
      }
      assert.equal(digest(numericRows(fullDb.sqlite)), beforeNumeric);
      fullSyncCost = summarizeCost(fullDb.stats);
      fullSyncCost.bindingCalls = { individual: fullDb.singleCalls, batch: fullDb.batchCalls };
    } finally { fullDb.sqlite.close(); }
    const run1 = rawSnapshot(sqlite);
    const registry = tableRows(sqlite, 'sec_raw_runtime');
    const run1Digest = digest(run1);
    const afterCoverage = coverage(sqlite);
    // 기간/파생 정책은 하나도 바꾸지 않았다. raw flow 전체 값/출처 deep equality를 확인한다.
    const flow = values => values.filter(row => row.period_type !== 'instant')
      .map(({ updated_at, created_at, ...semantic }) => semantic);
    assert.deepEqual(flow(run1.values), flow(rawSnapshot(baselineDB).values));
    assert.deepEqual(flow(run1.provenance), flow(rawSnapshot(baselineDB).provenance));
    const lost = new Map(inspection.observations.filter(o => o.type === 'INSTANT_WINDOW_EXCLUSION')
      .map(o => [JSON.stringify([o.ticker, o.metric, o.targetEnd]), o]));
    assert.equal(lost.size, 285);
    const recovery = { candidates: lost.size, recovered: 0, actualMissing: 0, semanticLimitations: [] };
    for (const candidate of lost.values()) {
      const row = sqlite.prepare(`SELECT * FROM sec_standard_raw_metrics WHERE ticker=? AND metric_name=?
        AND period_type='instant' AND period_end=?`).get(candidate.ticker, candidate.metric, candidate.targetEnd);
      if (row?.availability === 'available') recovery.recovered++;
      else if (row?.availability === 'missing') recovery.actualMissing++;
      else recovery.semanticLimitations.push({ ticker: candidate.ticker, metric: candidate.metric, end: candidate.targetEnd,
        availability: row?.availability || 'absent', reason: row?.reason || null });
    }
    const targetSnapshots = sqlite.prepare(`SELECT DISTINCT f.ticker,r.metric_name,r.period_end,r.availability
      FROM financial_metrics f LEFT JOIN sec_standard_raw_metrics r ON r.ticker=f.ticker
      AND r.period_type='instant' AND r.value_kind='point_in_time' AND r.period_end=f.fiscal_period_end`).all();
    assert.ok(targetSnapshots.every(row => row.metric_name));
    const remainingTargets = { basis: 'annual/quarterly 중복 end를 제거한 고유 ticker/metric/end',
      total: targetSnapshots.length, available: targetSnapshots.filter(row => row.availability === 'available').length,
      missing: targetSnapshots.filter(row => row.availability === 'missing').length,
      needsReview: targetSnapshots.filter(row => row.availability === 'needs_review').length, absent: 0 };
    // 원문 후보가 존재하는 285건은 모두 복구되어야 한다. 애매한 경우 숫자를 맞추지 않고 실패한다.
    assert.equal(recovery.recovered, 285);
    const run1Counts = { rawRows: run1.values.length, provenance: run1.provenance.length,
      available: run1.values.filter(row => row.availability === 'available').length,
      missing: run1.values.filter(row => row.availability === 'missing').length,
      needsReview: run1.values.filter(row => row.availability === 'needs_review').length,
      registry: registry.length, guard: count(sqlite, 'sec_raw_runtime_guard'),
      duplicates: sqlite.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM sec_standard_raw_metrics
        GROUP BY ticker,metric_name,period_type,period_start,period_end HAVING COUNT(*)>1)`).get().n,
      orphans: sqlite.prepare(`SELECT COUNT(*) n FROM sec_standard_raw_provenance p LEFT JOIN sec_standard_raw_metrics m
        ON p.ticker=m.ticker AND p.metric_name=m.metric_name AND p.period_type=m.period_type
        AND p.period_start=m.period_start AND p.period_end=m.period_end WHERE m.ticker IS NULL`).get().n };
    const dei = run1.provenance.filter(row => row.sec_tag === 'EntityCommonStockSharesOutstanding');
    assert.ok(dei.length > 0);
    assert.ok(dei.every(row => row.period_type === 'instant' && row.period_start === '' && row.source_end === row.period_end
      && JSON.parse(row.source_refs_json).every(ref => ref.end === row.period_end)));
    assert.equal(run1Counts.duplicates, 0); assert.equal(run1Counts.orphans, 0); assert.equal(run1Counts.guard, 0);
    // 공개 테스트와 분리해도 실제 10종목 evidence의 기존 registry 계약을 약화하지 않는다.
    assert.equal(registry.length, 10);
    db.reset();
    for (const [ticker, payload] of facts) assert.equal((await syncStandardRawFromSec(env, ticker, latestRawAccession(payload))).status, 'unchanged');
    const run2Cost = summarizeCost(db.stats);
    run2Cost.bindingCalls = { individual: db.singleCalls, batch: db.batchCalls };
    assert.equal(digest(rawSnapshot(sqlite)), run1Digest);
    assert.deepEqual(tableRows(sqlite, 'sec_raw_runtime'), registry);
    assert.equal(run2Cost.logicalChanges, 0);
    assert.equal(digest(tableRows(sqlite, 'financial_metrics', 'ticker,period_type,fiscal_period_end')), protectedBefore.financial);
    assert.equal(digest(tableRows(sqlite, 'company_classification')), protectedBefore.classification);
    assert.equal(digest(tableRows(sqlite, 'financial_metric_provenance', 'ticker,period_type,fiscal_period_end,metric_name')), protectedBefore.provenance);
    if (historicalCache) assert.deepEqual(specializedSnapshot(sqlite), specialized);
    const pageSize = sqlite.prepare('PRAGMA page_size').get().page_size;
    const afterPages = sqlite.prepare('PRAGMA page_count').get().page_count;
    assert.equal(forbiddenCalls, 0);
    return { scope: 'R4 실제 원문 재사용 + 메모리 disposable SQLite만 사용',
      apiCalls: { SEC: 0, BQ: 0, FMP: 0, Massive: 0 }, hashesVerified: 10,
      retention: { ...recovery, remainingTargets, deiActualDatesPreserved: dei.length }, coverage: { before: beforeCoverage, after: afterCoverage,
        perTicker: Object.fromEntries([...facts.keys()].map(ticker => [ticker,
          { before: coverage(baselineDB, ticker), after: coverage(sqlite, ticker) }])) },
      run1: run1Counts, run2: { semanticChanges: 0, registryGrowth: 0, logicalChanges: 0, digest: run1Digest },
      regression: { financialRows: 500, numericDigest: protectedBefore.numeric, financialAllColumnsUnchanged: true,
        classificationUnchanged: true, financialProvenanceUnchanged: true, flowUnchanged: true, specialized },
      cost: { run1: run1Cost, perTicker: perTickerCost, run2: run2Cost,
        legacyAndRaw: fullSyncCost,
        registry: registryRun1Cost,
        sqlitePageBytesIncrease: (afterPages - beforePages) * pageSize,
        quota: 'NOT VERIFIED', cpu: 'NOT VERIFIED' },
      readiness: { rawFoundation: 'NOT READY — 실제 Free CPU/D1 quota 미검증', ebitEbitdaUI: 'PARTIAL',
        policy: 'A — strict optional sparse metric' }, productionChanged: false };
  } finally { baselineDB?.close(); sqlite.close(); globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--read-only-cache')) throw Error('기존 외부 cache만 --read-only-cache로 지정하세요.');
  const result = await runRawRuntimeAudit({ historicalCache: args[1] || null });
  // 상세 결과는 함수 반환값으로 보존하고 기본 CLI에는 반복되는 10종목 전체 matrix를 쏟아내지 않는다.
  const fraction = row => `${row.available}/${row.total}`;
  const metricCoverage = Object.fromEntries(Object.keys(STANDARD_RAW_METRICS).map(metric => [metric,
    Object.fromEntries(['annual','quarterly','ytd'].map(type => [type,
      `${fraction(result.coverage.before[metric][type])} → ${fraction(result.coverage.after[metric][type])}`]))]));
  console.log(JSON.stringify({ ...result,
    coverage: { basis: 'point는 financial exact end, flow는 raw 실제 start/end; annual/quarterly 중복 별도 집계', metricCoverage },
    cost: { ...result.cost, perTicker: undefined } }, null, 2));
}
