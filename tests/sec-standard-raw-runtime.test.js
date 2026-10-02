import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { extractStandardRawMetrics, STANDARD_RAW_METRICS } from '../worker/src/sec-standard-raw.js';
import { saveStandardRawMetrics } from '../worker/src/sec-standard-raw-store.js';
import { runStandardRawRuntime, assertRawRuntimeSchema, latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { syncFinancialsFromSec, syncStandardRawFromSec } from '../worker/src/fmp-sync.js';
import { runFundamentalBatch } from '../worker/src/fundamental-sync.js';
import { ensureFundamentalStore } from '../worker/src/fundamental-store.js';
import { createRawRuntimeDatabase } from './helpers/sec-standard-raw-runtime-db.js';
import { oR2Facts, syntheticCompanyFacts, addFact, secFact } from './helpers/sec-standard-raw-fixtures.js';
import { runRawRuntimeAudit } from '../scripts/sec-standard-raw-runtime-audit.mjs';

const migration = readFileSync(new URL('../worker/migrations/0021_sec_standard_raw_runtime.sql', import.meta.url), 'utf8');
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const state = sqlite => sqlite.prepare("SELECT * FROM sec_raw_runtime WHERE ticker='O'").get();
const legacy = sqlite => sqlite.prepare('SELECT * FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end').all();
const raw = sqlite => sqlite.prepare('SELECT * FROM sec_standard_raw_metrics ORDER BY metric_name,period_type,period_start,period_end').all();
const fixture = () => {
  const db = createRawRuntimeDatabase();
  db.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('O','로컬 검증','726728')");
  const facts = oR2Facts();
  const env = { DB: db.DB, SEC_STANDARD_RAW_FIELDS_ENABLED: 'true', secFacts: new Map([['O', facts]]) };
  return { ...db, db, env, facts, accession: latestRawAccession(facts) };
};
const execute = ctx => runStandardRawRuntime(ctx.env, 'O', ctx.accession, async () => ctx.facts);
const due = sqlite => sqlite.exec("UPDATE sec_raw_runtime SET next_run_at='2000-01-01T00:00:00.000Z' WHERE ticker='O'");

test('R5 fresh/existing 0021 additive-only: 기존 숫자 및 migration 0020 불변', () => {
  const db = createRawRuntimeDatabase(20);
  try {
    db.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','검증'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source) VALUES ('O','annual','2025-12-31',42,'TEST')");
    const before = legacy(db.sqlite);
    assert.ok(!/\b(?:DROP|ALTER|UPDATE|DELETE)\b/i.test(migration));
    db.sqlite.exec(migration);
    assert.deepEqual(legacy(db.sqlite), before);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(count(db.sqlite, 'sec_raw_runtime'), 0);
  } finally { db.sqlite.close(); }
  const fresh = createRawRuntimeDatabase(); fresh.sqlite.close();
});

test('R5 migration 0021 누락은 legacy 쓰기 전 safe-fail', async () => {
  const db = createRawRuntimeDatabase(20);
  try {
    db.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','검증')");
    await assert.rejects(syncFinancialsFromSec({ DB: db.DB, secFacts: new Map([['O', oR2Facts()]]),
      SEC_STANDARD_RAW_FIELDS_ENABLED: 'true' }, 'O'), /0021/);
    assert.equal(count(db.sqlite, 'financial_metrics'), 0);
    await assert.rejects(assertRawRuntimeSchema(db.DB), /0021/);
  } finally { db.sqlite.close(); }
});

test('R5 기본 flag false: runtime/query/write/fetch 모두 없음', async () => {
  const c = fixture();
  try {
    c.env.SEC_STANDARD_RAW_FIELDS_ENABLED = undefined; c.db.reset();
    assert.equal((await execute(c)).status, 'disabled');
    assert.equal(c.db.stats.length, 0); assert.equal(count(c.sqlite, 'sec_raw_runtime'), 0);
  } finally { c.sqlite.close(); }
});

test('R5 A legacy 미완료/raw 미완료: 동일 payload에서 두 상태 독립 완료', async () => {
  const c = fixture();
  try {
    await syncFinancialsFromSec(c.env, 'O');
    assert.ok(count(c.sqlite, 'financial_metrics') > 0);
    assert.equal(state(c.sqlite).raw_status, 'ready');
    assert.equal(state(c.sqlite).raw_last_accession, c.accession);
    assert.equal(state(c.sqlite).lease_token, null);
    assert.equal(count(c.sqlite, 'sec_raw_runtime_guard'), 0);
  } finally { c.sqlite.close(); }
});

test('R5 B legacy 완료/raw 없음: raw-only 초기 처리에서 legacy SQL write 0', async () => {
  const c = fixture();
  try {
    await syncFinancialsFromSec({ ...c.env, SEC_STANDARD_RAW_FIELDS_ENABLED: 'false' }, 'O');
    const before = legacy(c.sqlite); c.db.reset();
    assert.equal((await syncStandardRawFromSec(c.env, 'O', c.accession)).status, 'ready');
    assert.deepEqual(legacy(c.sqlite), before);
    assert.ok(!c.db.stats.some(s => /^(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?financial_metrics/i.test(s.sql.trim())));
  } finally { c.sqlite.close(); }
});

for (const label of ['C legacy 완료/raw 성공', 'F 동일 accession 재실행']) {
  test(`R5 ${label}: semantic/registry 변경 0, payload 조회 0`, async () => {
    const c = fixture();
    try {
      await execute(c); const before = raw(c.sqlite), prior = state(c.sqlite); c.db.reset();
      let calls = 0;
      const result = await runStandardRawRuntime(c.env, 'O', c.accession, async () => { calls++; throw Error('호출 금지'); });
      assert.equal(result.status, 'unchanged'); assert.equal(calls, 0);
      assert.deepEqual(raw(c.sqlite), before); assert.deepEqual(state(c.sqlite), prior);
      assert.equal(c.db.stats.reduce((sum, s) => sum + s.logicalChanges, 0), 0);
      assert.equal(c.db.batchCalls, 0);
    } finally { c.sqlite.close(); }
  });
}

for (const failureTable of ['sec_standard_raw_metrics','sec_standard_raw_provenance']) {
  test(`R5 D/E ${failureTable} SQL 실패: atomic rollback/legacy 유지/raw-only retry`, async () => {
    const c = fixture();
    try {
      await syncFinancialsFromSec({ ...c.env, SEC_STANDARD_RAW_FIELDS_ENABLED: 'false' }, 'O');
      const before = legacy(c.sqlite);
      c.sqlite.exec(`CREATE TRIGGER fail_test BEFORE INSERT ON ${failureTable} BEGIN SELECT RAISE(ABORT,'SQL_FAIL'); END`);
      assert.equal((await execute(c)).status, 'error');
      assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
      assert.equal(count(c.sqlite, 'sec_standard_raw_provenance'), 0);
      assert.equal(state(c.sqlite).raw_status, 'error'); assert.ok(state(c.sqlite).next_run_at);
      assert.equal(state(c.sqlite).raw_last_success_at, null); assert.equal(state(c.sqlite).lease_token, null);
      assert.deepEqual(legacy(c.sqlite), before);
      assert.equal((await execute(c)).status, 'deferred');
      c.sqlite.exec('DROP TRIGGER fail_test'); due(c.sqlite);
      assert.equal((await execute(c)).status, 'ready');
      assert.equal(state(c.sqlite).raw_last_error, null); assert.equal(state(c.sqlite).next_run_at, null);
      assert.deepEqual(legacy(c.sqlite), before);
    } finally { c.sqlite.close(); }
  });
}

test('R5 raw 완료 registry UPDATE 실패도 전체 batch rollback; 재시도는 안전', async () => {
  const c = fixture();
  try {
    c.sqlite.exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON sec_raw_runtime
      WHEN NEW.raw_status='ready' BEGIN SELECT RAISE(ABORT,'CHECKPOINT_FAIL'); END`);
    assert.equal((await execute(c)).status, 'error');
    assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
    assert.equal(state(c.sqlite).raw_last_accession, null);
    c.sqlite.exec('DROP TRIGGER fail_checkpoint'); due(c.sqlite);
    assert.equal((await execute(c)).status, 'ready');
  } finally { c.sqlite.close(); }
});

test('R5 복수 chunk 갱신 중간 실패는 기존 raw/출처/checkpoint까지 원복', async () => {
  const c = fixture();
  try {
    c.facts = syntheticCompanyFacts(); c.accession = latestRawAccession(c.facts);
    await execute(c); const before = raw(c.sqlite), old = state(c.sqlite);
    const provenance = c.sqlite.prepare('SELECT * FROM sec_standard_raw_provenance ORDER BY metric_name,period_type,period_start,period_end').all();
    addFact(c.facts, 'CashAndCashEquivalentsAtCarryingValue', secFact(null, '2016-03-31', 777,
      { form: '10-Q/A', filed: '2026-09-01', accn: 'new-accession', fp: 'Q1' }));
    c.accession = 'new-accession';
    c.sqlite.exec(`CREATE TRIGGER fail_middle BEFORE INSERT ON sec_standard_raw_provenance
      WHEN NEW.metric_name='weighted_average_shares_diluted' AND NEW.period_end='2025-12-31'
      BEGIN SELECT RAISE(ABORT,'MIDDLE_FAIL'); END`);
    assert.equal((await execute(c)).status, 'error'); assert.deepEqual(raw(c.sqlite), before);
    assert.deepEqual(c.sqlite.prepare('SELECT * FROM sec_standard_raw_provenance ORDER BY metric_name,period_type,period_start,period_end').all(), provenance);
    assert.equal(state(c.sqlite).raw_last_accession, old.raw_last_accession);
    assert.equal(state(c.sqlite).raw_last_success_at, old.raw_last_success_at);
    c.sqlite.exec('DROP TRIGGER fail_middle'); due(c.sqlite);
    assert.equal((await execute(c)).status, 'ready');
  } finally { c.sqlite.close(); }
});

test('R5 raw 선행 저장 후 완료 기록 전 중단 상태도 중복 없이 재실행', async () => {
  const c = fixture();
  try {
    await saveStandardRawMetrics(c.DB, 'O', extractStandardRawMetrics(c.facts));
    const before = raw(c.sqlite); const sources = count(c.sqlite, 'sec_standard_raw_provenance');
    assert.equal((await execute(c)).status, 'ready'); assert.deepEqual(raw(c.sqlite), before);
    assert.equal(count(c.sqlite, 'sec_standard_raw_provenance'), sources);
  } finally { c.sqlite.close(); }
});

test('R5 G 신규 SEC accession: 새 제출값/출처 보존, legacy/checkpoint 재작성 없음', async () => {
  const c = fixture();
  try {
    await execute(c); const before = legacy(c.sqlite);
    addFact(c.facts, 'CashAndCashEquivalentsAtCarryingValue', secFact(null, '2026-06-30', 777,
      { form: '10-Q/A', filed: '2026-09-01', accn: 'new-filing', fp: 'Q2' }));
    c.accession = 'new-filing'; assert.equal((await execute(c)).status, 'ready');
    assert.equal(state(c.sqlite).raw_last_accession, 'new-filing');
    assert.deepEqual(legacy(c.sqlite), before);
    assert.equal(c.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents' AND period_end='2026-06-30'").get().metric_value, 777);
  } finally { c.sqlite.close(); }
});

test('R5 CompanyFacts 미색인 accession은 성공으로 승인하지 않는다', async () => {
  const c = fixture();
  try { c.accession = 'not-indexed'; assert.equal((await execute(c)).status, 'error');
    assert.equal(state(c.sqlite).raw_last_accession, null); assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
  } finally { c.sqlite.close(); }
});

test('R5 active lease 중복 claim 거부, stale owner fencing으로 write 차단', async () => {
  const c = fixture();
  try {
    const first = await runStandardRawRuntime(c.env, 'O', c.accession, async () => {
      assert.equal((await execute(c)).status, 'deferred');
      c.sqlite.exec("UPDATE sec_raw_runtime SET fence=fence+1,lease_token='new-owner' WHERE ticker='O'");
      return c.facts;
    });
    assert.equal(first.status, 'error'); assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
    assert.equal(state(c.sqlite).lease_token, 'new-owner'); assert.equal(state(c.sqlite).raw_status, 'running');
  } finally { c.sqlite.close(); }
});

test('R5 lease 경과 후 batch 진입 거부', async () => {
  const c = fixture();
  try {
    const result = await runStandardRawRuntime(c.env, 'O', c.accession, async () => {
      c.sqlite.exec("UPDATE sec_raw_runtime SET lease_until='2000-01-01T00:00:00.000Z' WHERE ticker='O'");
      return c.facts;
    });
    assert.equal(result.status, 'error'); assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
  } finally { c.sqlite.close(); }
});

test('R5 예외 URL/credential 원문을 registry/log에 남기지 않는다', async () => {
  const c = fixture();
  try { const result = await runStandardRawRuntime(c.env, 'O', c.accession, async () => { throw Error('private-url-SENSITIVE'); });
    assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(state(c.sqlite)).includes('SENSITIVE'));
  } finally { c.sqlite.close(); }
});

test('R5 registry version upgrade는 legacy와 독립, 새 schema/data 완료 버전 저장', async () => {
  const c = fixture();
  try {
    await execute(c); const before = raw(c.sqlite);
    c.sqlite.exec("UPDATE sec_raw_runtime SET raw_data_version=1,attempt_data_version=1 WHERE ticker='O'");
    assert.equal((await execute(c)).status, 'ready'); assert.equal(state(c.sqlite).raw_data_version, 2);
    assert.equal(state(c.sqlite).raw_schema_version, 1); assert.deepEqual(raw(c.sqlite), before);
    assert.equal(state(c.sqlite).attempt_count, 2);
  } finally { c.sqlite.close(); }
});

test('R5 ready registry라도 raw 행이 사라졌으면 초기 재처리', async () => {
  const c = fixture();
  try {
    await execute(c);
    c.sqlite.exec('DELETE FROM sec_standard_raw_provenance; DELETE FROM sec_standard_raw_metrics');
    assert.equal((await execute(c)).status, 'ready'); assert.ok(count(c.sqlite, 'sec_standard_raw_metrics') > 0);
  } finally { c.sqlite.close(); }
});

test('R5 ready registry의 현재 provenance 누락도 안전하게 복구', async () => {
  const c = fixture();
  try {
    await execute(c); const original = count(c.sqlite, 'sec_standard_raw_provenance');
    c.sqlite.exec('DELETE FROM sec_standard_raw_provenance');
    assert.equal((await execute(c)).status, 'ready');
    assert.equal(count(c.sqlite, 'sec_standard_raw_provenance'), original);
  } finally { c.sqlite.close(); }
});

test('R5 A raw 저장 장애라도 최초 legacy 수집 정상 완료/반환 유지', async () => {
  const c = fixture();
  try {
    c.sqlite.exec("CREATE TRIGGER fail_raw BEFORE INSERT ON sec_standard_raw_provenance BEGIN SELECT RAISE(ABORT,'FAIL'); END");
    const result = await syncFinancialsFromSec(c.env, 'O');
    assert.equal(result.source, 'SEC EDGAR'); assert.ok(result.annualCount > 0);
    assert.equal(state(c.sqlite).raw_status, 'error'); assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
    assert.ok(count(c.sqlite, 'financial_metrics') > 0);
  } finally { c.sqlite.close(); }
});

test('R5 registry claim SQL 실패도 legacy 정상 결과 유지; 성공으로 오인 금지', async () => {
  const c = fixture();
  try {
    c.sqlite.exec("CREATE TRIGGER fail_registry BEFORE INSERT ON sec_raw_runtime BEGIN SELECT RAISE(ABORT,'FAIL'); END");
    const result = await syncFinancialsFromSec(c.env, 'O');
    assert.equal(result.source, 'SEC EDGAR'); assert.ok(result.annualCount > 0);
    assert.equal(count(c.sqlite, 'sec_raw_runtime'), 0);
    assert.equal(count(c.sqlite, 'sec_standard_raw_metrics'), 0);
  } finally { c.sqlite.close(); }
});

test('R5 새로운 accession 실패는 이전 성공 checkpoint 보존, retry due 준수', async () => {
  const c = fixture();
  try {
    await execute(c); const old = state(c.sqlite);
    c.accession = 'new-unindexed'; assert.equal((await execute(c)).status, 'error');
    assert.equal(state(c.sqlite).raw_last_accession, old.raw_last_accession);
    assert.equal(state(c.sqlite).raw_last_success_at, old.raw_last_success_at);
    assert.equal(state(c.sqlite).attempt_accession, 'new-unindexed');
    assert.equal((await execute(c)).status, 'deferred');
  } finally { c.sqlite.close(); }
});

test('R5 10FY/40Q 보호와 별도 DEI 60-date 창; 가짜 cash 값 생성 없음', () => {
  const facts = syntheticCompanyFacts();
  for (let i = 0; i < 90; i++) {
    const end = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    addFact(facts, 'EntityCommonStockSharesOutstanding', secFact(null, end, 999,
      { form: '10-Q', filed: '2026-08-01', accn: 'synthetic-dei' }), 'shares', 'dei');
  }
  const financialPeriods = Array.from({ length: 40 }, (_, i) => ({ period_type: 'quarterly',
    fiscal_period_end: `${2016 + Math.floor(i / 4)}-${['03-31','06-30','09-30','12-31'][i % 4]}` }));
  financialPeriods.push(...Array.from({ length: 10 }, (_, i) => ({ period_type: 'annual', fiscal_period_end: `${2016 + i}-12-31` })));
  const records = extractStandardRawMetrics(facts, { minimumYear: 2016, financialPeriods });
  for (const metric of Object.entries(STANDARD_RAW_METRICS).filter(([, v]) => v.kind === 'point_in_time').map(([k]) => k)) {
    for (const period of financialPeriods) assert.equal(records.find(r => r.metricName === metric
      && r.periodEnd === period.fiscal_period_end && r.periodType === 'instant').availability, 'available');
  }
  const dei = records.filter(r => r.metricName === 'shares_outstanding' && r.provenance?.secTag === 'EntityCommonStockSharesOutstanding');
  assert.equal(dei.length, 60); assert.equal(dei.at(-1).periodEnd, '2026-03-31');
  assert.equal(records.find(r => r.metricName === 'cash_and_cash_equivalents' && r.periodEnd === '2026-03-31').metricValue, null);
});

test('R5 보호 기간 원문 없으면 명시적 NULL; 평균/DEI를 잔액으로 이동하지 않는다', () => {
  const records = extractStandardRawMetrics(oR2Facts(), { financialPeriods: [{ period_type: 'annual', fiscal_period_end: '2016-12-31' }] });
  assert.equal(records.find(r => r.metricName === 'shares_outstanding' && r.periodEnd === '2016-12-31').availability, 'missing');
});

test('R5 registry query는 raw 행 수와 무관, 단일 batch/row-by-row SELECT 없음', async () => {
  const c = fixture();
  try {
    c.facts = syntheticCompanyFacts(); c.accession = latestRawAccession(c.facts); c.db.reset();
    await execute(c);
    assert.equal(c.db.stats.filter(s => /^SELECT/i.test(s.sql)).length, 2);
    assert.equal(c.db.batchCalls, 1);
    assert.ok(c.db.stats.length < 20);
    assert.ok(c.db.stats.every(s => s.bindings <= 100));
  } finally { c.sqlite.close(); }
});

/** fake fetch는 오직 이미 확보된 payload만 반환한다. 실제 네트워크는 호출하지 않는다. */
async function schedulerFixture(t) {
  const c = fixture();
  await syncFinancialsFromSec({ ...c.env, SEC_STANDARD_RAW_FIELDS_ENABLED: 'false' }, 'O');
  await ensureFundamentalStore(c.env);
  c.sqlite.exec("INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0)");
  const details = { source: 'SEC EDGAR', annualCount: 1, quarterlyCount: 1, metadataVersion: 1 };
  c.sqlite.prepare(`INSERT INTO sec_filing_checks(ticker,accession) VALUES (?,?)`).run('O', c.accession);
  c.sqlite.prepare(`INSERT INTO fundamental_jobs(ticker,kind,status,details,next_run_at) VALUES ('O','financials','ready',?,?)`)
    .run(JSON.stringify(details), '2000-01-01T00:00:00.000Z');
  c.sqlite.exec("INSERT INTO fundamental_jobs(ticker,kind,status,details,next_run_at) VALUES ('O','profile','ready','{}','2099-01-01T00:00:00.000Z')");
  let companyFactsCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/submissions/')) return Response.json({ filings: { recent: { form: ['10-Q'],
      accessionNumber: [c.accession], reportDate: ['2026-06-30'] } } });
    if (String(url).includes('/companyfacts/')) { companyFactsCalls++; return Response.json({ facts: c.facts }); }
    throw Error('다른 endpoint 호출 금지');
  });
  return { ...c, calls: () => companyFactsCalls };
}

test('R5 실제 큐 legacy 완료 skip guard에서 raw 초기 저장, legacy 숫자 유지', async t => {
  const c = await schedulerFixture(t);
  try {
    const before = legacy(c.sqlite); await runFundamentalBatch(c.env, 'O');
    assert.equal(state(c.sqlite).raw_status, 'ready'); assert.deepEqual(legacy(c.sqlite), before);
    assert.equal(c.calls(), 1); assert.equal(c.sqlite.prepare("SELECT status FROM fundamental_jobs WHERE kind='financials'").get().status, 'ready');
  } finally { c.sqlite.close(); }
});

test('R5 실제 큐 raw failure는 legacy ready/checkpoint 유지, retry는 legacy 미래 실행일과 독립', async t => {
  const c = await schedulerFixture(t);
  try {
    const before = legacy(c.sqlite);
    c.sqlite.exec("CREATE TRIGGER fail_test BEFORE INSERT ON sec_standard_raw_provenance BEGIN SELECT RAISE(ABORT,'FAIL'); END");
    await runFundamentalBatch(c.env, 'O');
    assert.equal(state(c.sqlite).raw_status, 'error');
    const job = c.sqlite.prepare("SELECT * FROM fundamental_jobs WHERE kind='financials'").get();
    assert.equal(job.status, 'ready'); assert.equal(job.error, null); assert.ok(job.next_run_at > new Date().toISOString());
    assert.equal(c.sqlite.prepare('SELECT accession FROM sec_filing_checks').get().accession, c.accession);
    c.sqlite.exec('DROP TRIGGER fail_test'); due(c.sqlite);
    await runFundamentalBatch(c.env, 'O');
    assert.equal(state(c.sqlite).raw_status, 'ready'); assert.deepEqual(legacy(c.sqlite), before);
    assert.deepEqual(c.sqlite.prepare("SELECT * FROM fundamental_jobs WHERE kind='financials'").get(), job);
  } finally { c.sqlite.close(); }
});

test('R5 raw-only 큐 공시 목록 장애는 legacy job을 수정하지 않고 retry 기록', async t => {
  const c = await schedulerFixture(t);
  try {
    c.sqlite.exec("UPDATE fundamental_jobs SET next_run_at='2099-01-01T00:00:00.000Z'");
    const job = c.sqlite.prepare("SELECT * FROM fundamental_jobs WHERE kind='financials'").get();
    t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
    await runFundamentalBatch(c.env, 'O');
    assert.equal(state(c.sqlite).raw_status, 'error'); assert.ok(state(c.sqlite).next_run_at);
    assert.deepEqual(c.sqlite.prepare("SELECT * FROM fundamental_jobs WHERE kind='financials'").get(), job);
  } finally { c.sqlite.close(); }
});

test('R5 실제 R4 10종목 cache: lost 285 복구/financial 500행/flow/Run2 regression',
  { skip: !existsSync(new URL('../backups/r4/acquisition.json', import.meta.url)) }, async () => {
    const report = await runRawRuntimeAudit();
    assert.equal(report.hashesVerified, 10); assert.equal(report.retention.recovered, 285);
    assert.equal(report.run1.registry, 10); assert.equal(report.run1.duplicates, 0); assert.equal(report.run1.orphans, 0);
    assert.equal(report.run2.logicalChanges, 0); assert.equal(report.run2.registryGrowth, 0);
    assert.equal(report.regression.financialRows, 500); assert.equal(report.regression.flowUnchanged, true);
    assert.deepEqual(report.apiCalls, { SEC: 0, BQ: 0, FMP: 0, Massive: 0 });
  });
