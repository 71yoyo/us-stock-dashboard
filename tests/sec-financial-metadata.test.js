import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { latestSecValues, selectSecFacts, syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { buildSecPeriodIndex, resolveSecPeriodMetadata } from '../worker/src/sec-financial-metadata.js';
import { ensureFundamentalStore } from '../worker/src/fundamental-store.js';
import { runFundamentalBatch } from '../worker/src/fundamental-sync.js';
import worker from '../worker/src/index.js';

const migrations = readdirSync(new URL('../worker/migrations/', import.meta.url)).sort();
const metadataMigration = '0016_sec_financial_metadata.sql';
const sqlFor = name => readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8');
const forms = ['10-K', '10-K/A', '10-Q', '10-Q/A'];

// 모든 쓰기는 폐기 가능한 메모리 SQLite에만 수행한다. 운영 D1·인증키·실제 API를 사용하지 않는다.
function database(includeMetadata = true) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations) {
    if (!includeMetadata && name === metadataMigration) break;
    sqlite.exec(sqlFor(name));
  }
  const prepare = sql => ({ sql, values: [], bind(...values) { this.values = values; return this; },
    async first() { return sqlite.prepare(sql).get(...this.values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
    async run() { return sqlite.prepare(sql).run(...this.values); }
  });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(item => ({ results: sqlite.prepare(item.sql).all(...item.values) }));
      sqlite.exec('COMMIT');
      return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB };
}

// 아래 fact는 기간 판정의 경계 조건을 검증하는 인공 자료이며 실제 NVDA SEC 응답이 아니다.
function fact(start, end, val, extra = {}) {
  return { start, end, val, fy: 2027, fp: 'Q2', form: '10-Q',
    filed: '2026-08-26', accn: 'test-q2', ...extra };
}

function selected(entries, periodType = 'quarterly', tag = 'Revenues') {
  const records = selectSecFacts({ 'us-gaap': { [tag]: { units: {
    [tag.includes('EarningsPerShare') ? 'USD/shares' : 'USD']: entries
  } } } }, [tag], [tag.includes('EarningsPerShare') ? 'USD/shares' : 'USD']);
  return { records, values: latestSecValues(records, forms, 1900, periodType) };
}

function metadata(records, entry, periodType = 'quarterly') {
  return resolveSecPeriodMetadata(buildSecPeriodIndex({ metric: records }), periodType, entry.end, [entry]);
}

test('새 마이그레이션은 빈 DB에 전체 순서로 적용되고 기간·출처 키를 추가한다', () => {
  const { sqlite } = database();
  try {
    const columns = sqlite.prepare('PRAGMA table_info(financial_metrics)').all().map(row => row.name);
    for (const field of ['fiscal_year', 'fiscal_period', 'period_start']) assert.ok(columns.includes(field));
    const provenance = sqlite.prepare('PRAGMA table_info(financial_metric_provenance)').all();
    assert.deepEqual(provenance.filter(row => row.pk).map(row => row.name),
      ['ticker', 'period_type', 'fiscal_period_end', 'metric_name']);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_financial_metric_provenance_filing'").get());
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('기존 DB에 새 마이그레이션만 적용해도 실제 NVDA 저장값 표본을 바꾸거나 FY/Q를 추정하지 않는다', () => {
  const { sqlite } = database(false);
  try {
    // 2026-09-30 공개 회사 API 읽기 전용 조회값이다. SEC 원본을 대신하는 자료로 사용하지 않는다.
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('NVDA','NVIDIA Corporation')");
    const rows = [
      ['annual', '2026-01-25', 215938000000, 130387000000, 120067000000, 4.9,
        96676000000, 76.33333969089534, 71.06808435754708, 60.38168363141272],
      ['annual', '2025-01-26', 130497000000, 81453000000, 72880000000, 2.94,
        60853000000, 91.87288060811576, 74.98869705816992, 62.417526839697466],
      ['quarterly', '2026-07-26', 96221000000, 63734000000, 59688000000, 2.46,
        21400000000, 26.06645005764595, 74.97531723844068, 66.23710000935347],
      ['quarterly', '2026-01-25', 68127000000, 44299000000, 42960000000, null,
        34904000000, 27.312086361122233, 74.99669734466511, 65.02414608011507]
    ];
    for (const row of rows) sqlite.prepare(`INSERT INTO financial_metrics
      (ticker,period_type,fiscal_period_end,revenue,operating_income,net_income,eps,
       free_cash_flow,roe,gross_margin,operating_margin,source)
      VALUES ('NVDA',?,?,?,?,?,?,?,?,?,?,'SEC EDGAR')`).run(...row);
    const query = `SELECT period_type,fiscal_period_end,revenue,operating_income,net_income,eps,
      free_cash_flow,roe,gross_margin,operating_margin FROM financial_metrics ORDER BY period_type,fiscal_period_end`;
    const before = sqlite.prepare(query).all();
    sqlite.exec(sqlFor(metadataMigration));
    assert.deepEqual(sqlite.prepare(query).all(), before);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM financial_metrics
      WHERE fiscal_year IS NOT NULL OR fiscal_period IS NOT NULL OR period_start IS NOT NULL`).get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM financial_metric_provenance').get().n, 0);
  } finally { sqlite.close(); }
});

test('단위 키와 SEC 원본 fy/fp/form/filed/accn/frame/start/end/val을 보존한다', () => {
  const original = fact('2026-04-27', '2026-07-26', 100, { frame: 'CY2026Q2' });
  const { records } = selected([original]);
  for (const field of ['fy', 'fp', 'form', 'filed', 'accn', 'frame', 'start', 'end', 'val']) {
    assert.equal(records[0][field], original[field]);
  }
  assert.equal(records[0].unit, 'USD');
  assert.equal(records[0].taxonomy, 'us-gaap');
});

test('Annual 원본 fy=2026 fp=FY는 FY2026과 실제 시작일로 식별한다', () => {
  const { records, values } = selected([fact('2025-01-27', '2026-01-25', 1000,
    { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy' })], 'annual');
  assert.deepEqual(metadata(records, values.get('2026-01-25'), 'annual'),
    { fiscalYear: 2026, fiscalPeriod: 'FY', periodStart: '2025-01-27' });
});

test('Q1 직접값은 원본 회사 FY/Q1을 유지한다', () => {
  const { records, values } = selected([fact('2026-01-26', '2026-04-26', 10,
    { fp: 'Q1', filed: '2026-05-20', accn: 'test-q1' })]);
  assert.deepEqual(metadata(records, values.get('2026-04-26')),
    { fiscalYear: 2027, fiscalPeriod: 'Q1', periodStart: '2026-01-26' });
});

test('7월 종료 Q2 직접값은 달력 Q3가 아니라 원본 Q2 FY2027로 식별한다', () => {
  const { records, values } = selected([fact('2026-04-27', '2026-07-26', 100)]);
  assert.deepEqual(metadata(records, values.get('2026-07-26')),
    { fiscalYear: 2027, fiscalPeriod: 'Q2', periodStart: '2026-04-27' });
});

test('Q2 누적 차감은 값 15와 Q2 metadata 및 두 원본을 보존한다', () => {
  const { records, values } = selected([
    fact('2026-01-26', '2026-04-26', 10, { fp: 'Q1', filed: '2026-05-20', accn: 'test-q1' }),
    fact('2026-01-26', '2026-07-26', 25)
  ]);
  const entry = values.get('2026-07-26');
  assert.equal(entry.val, 15);
  assert.equal(entry.calculationType, 'ytd_difference');
  assert.deepEqual(metadata(records, entry),
    { fiscalYear: 2027, fiscalPeriod: 'Q2', periodStart: '2026-04-27' });
  assert.deepEqual(entry.sourceRefs.map(ref => [ref.accession, ref.value, ref.start, ref.end, ref.unit]), [
    ['test-q2', 25, '2026-01-26', '2026-07-26', 'USD'],
    ['test-q1', 10, '2026-01-26', '2026-04-26', 'USD']
  ]);
});

test('Q3 누적 차감은 9개월과 6개월 원본 및 실제 Q3 시작일을 보존한다', () => {
  const { records, values } = selected([
    fact('2026-01-26', '2026-07-26', 25),
    fact('2026-01-26', '2026-10-25', 60,
      { fp: 'Q3', filed: '2026-11-18', accn: 'test-q3' })
  ]);
  const entry = values.get('2026-10-25');
  assert.equal(entry.val, 35);
  assert.equal(entry.calculationType, 'ytd_difference');
  assert.deepEqual(metadata(records, entry),
    { fiscalYear: 2027, fiscalPeriod: 'Q3', periodStart: '2026-07-27' });
  assert.deepEqual(entry.sourceRefs.map(ref => ref.value), [60, 25]);
});

test('FY−9M의 Q4는 FY와 9M 근거 및 9M 종료 다음 날을 저장한다', () => {
  const { records, values } = selected([
    fact('2025-01-27', '2025-10-26', 600,
      { fy: 2026, fp: 'Q3', filed: '2025-11-19', accn: 'test-old-q3' }),
    fact('2025-01-27', '2026-01-25', 1000,
      { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy' })
  ]);
  const entry = values.get('2026-01-25');
  assert.equal(entry.val, 400);
  assert.equal(entry.calculationType, 'fy_minus_9m');
  assert.deepEqual(metadata(records, entry),
    { fiscalYear: 2026, fiscalPeriod: 'Q4', periodStart: '2025-10-27' });
  assert.deepEqual(entry.sourceRefs.map(ref => [ref.form, ref.accession, ref.value]),
    [['10-K', 'test-fy', 1000], ['10-Q', 'test-old-q3', 600]]);
});

test('같은 직접값 후보의 수정 공시는 최신 filed를 쓰는 기존 정책을 유지한다', () => {
  const { values } = selected([
    fact('2026-04-27', '2026-07-26', 100),
    fact('2026-04-27', '2026-07-26', 110,
      { form: '10-Q/A', filed: '2026-09-01', accn: 'test-q2-amended' })
  ]);
  assert.equal(values.get('2026-07-26').val, 110);
  assert.equal(values.get('2026-07-26').accn, 'test-q2-amended');
});

test('새 수정 공시 차감값보다 오래된 직접값을 우선하는 기존 위험 정책을 명시한다', () => {
  const { values } = selected([
    fact('2026-04-27', '2026-07-26', 100),
    fact('2026-01-26', '2026-04-26', 10, { fp: 'Q1', filed: '2026-05-20', accn: 'test-q1' }),
    fact('2026-01-26', '2026-07-26', 120,
      { form: '10-Q/A', filed: '2026-09-01', accn: 'test-q2-amended' })
  ]);
  const entry = values.get('2026-07-26');
  assert.equal(entry.val, 100);
  assert.equal(entry.filed, '2026-08-26');
  assert.equal(Boolean(entry.derived), false);
});

test('EPS는 YTD 차감으로 Q4를 생성하지 않고 단위를 보존한다', () => {
  const entries = [
    fact('2025-01-27', '2025-10-26', 2.7,
      { fy: 2026, fp: 'Q3', filed: '2025-11-19', accn: 'test-old-q3' }),
    fact('2025-01-27', '2026-01-25', 4,
      { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy' })
  ];
  const { values } = selected(entries, 'quarterly', 'EarningsPerShareDiluted');
  assert.equal(values.has('2026-01-25'), false);
  assert.equal(selected(entries, 'annual', 'EarningsPerShareDiluted').values.get('2026-01-25').unit, 'USD/shares');
});

test('최신 비교값의 제출 FY를 과거 fact의 실제 FY로 잘못 복사하지 않는다', () => {
  const { records, values } = selected([
    fact('2024-01-29', '2025-01-26', 100,
      { fy: 2025, fp: 'FY', form: '10-K', filed: '2025-02-26', accn: 'test-fy2025' }),
    fact('2024-01-29', '2025-01-26', 101,
      { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy2026' }),
    fact('2025-01-27', '2026-01-25', 200,
      { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy2026' })
  ], 'annual');
  const entry = values.get('2025-01-26');
  assert.equal(entry.val, 101);
  assert.equal(entry.fy, 2026);
  assert.equal(metadata(records, entry, 'annual').fiscalYear, 2025);
});

test('과거 비교값만 있고 원 공시 기간 근거가 없으면 FY를 추정하지 않는다', () => {
  const { records, values } = selected([fact('2024-01-29', '2025-01-26', 101,
    { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy2026' })], 'annual');
  assert.deepEqual(metadata(records, values.get('2025-01-26'), 'annual'),
    { fiscalYear: null, fiscalPeriod: null, periodStart: '2024-01-29' });
});

test('누락·상충 회계 metadata와 충돌하는 시작일은 NULL이며 값 선택은 유지한다', () => {
  const { records, values } = selected([fact('2026-04-27', '2026-07-26', 100,
    { fy: undefined, fp: undefined })]);
  const entry = values.get('2026-07-26');
  assert.equal(entry.val, 100);
  assert.equal(metadata(records, entry).fiscalYear, null);
  const conflict = selected([fact('2026-04-27', '2026-07-26', 100),
    fact('2026-04-27', '2026-07-26', 100, { fy: 2026, accn: 'conflicting-filing' })]);
  const index = buildSecPeriodIndex({ metric: conflict.records });
  assert.equal(resolveSecPeriodMetadata(index, 'quarterly', entry.end, [entry]).fiscalYear, null);
  assert.equal(resolveSecPeriodMetadata(index, 'quarterly', entry.end,
    [entry, { ...entry, start: '2026-04-28' }]).periodStart, null);
});

function artificialFacts() {
  const facts = { 'us-gaap': {} };
  const annual = (value, extra = {}) => fact('2025-01-27', '2026-01-25', value,
    { fy: 2026, fp: 'FY', form: '10-K', filed: '2026-02-25', accn: 'test-fy', ...extra });
  const q3 = (value, start = '2025-07-28') => fact(start, '2025-10-26', value,
    { fy: 2026, fp: 'Q3', filed: '2025-11-19', accn: 'test-old-q3' });
  const q1 = value => fact('2026-01-26', '2026-04-26', value,
    { fp: 'Q1', filed: '2026-05-20', accn: 'test-q1' });
  const q2 = value => fact('2026-04-27', '2026-07-26', value);
  const add = (tag, rows, unit = 'USD') => { facts['us-gaap'][tag] = { units: { [unit]: rows } }; };
  add('Revenues', [annual(1000), q3(600, '2025-01-27'), q3(300), q1(80), q2(100)]);
  add('OperatingIncomeLoss', [annual(300), q3(180, '2025-01-27'), q3(90), q1(24), q2(30)]);
  add('NetIncomeLoss', [annual(200), q3(120, '2025-01-27'), q3(60), q1(16), q2(20)]);
  add('EarningsPerShareDiluted', [annual(4), q3(2.7, '2025-01-27'), q3(1.2), q1(0.3), q2(0.4)], 'USD/shares');
  add('GrossProfit', [annual(750), q3(450, '2025-01-27'), q3(225), q1(60), q2(70)]);
  add('NetCashProvidedByUsedInOperatingActivities', [annual(250), q3(190, '2025-01-27'), q1(20),
    { ...q2(60), start: '2026-01-26' }]);
  add('PaymentsToAcquirePropertyPlantAndEquipment', [annual(50), q3(35, '2025-01-27'), q1(3),
    { ...q2(10), start: '2026-01-26' }]);
  add('StockholdersEquity', [annual(1000, { start: undefined }),
    { ...q3(800), start: undefined }, { ...q1(200), start: undefined }, { ...q2(200), start: undefined }]);
  return facts;
}

async function syncedDatabase() {
  const store = database();
  store.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('TEST','검증용 회사','1')");
  const environment = { DB: store.DB, secFacts: new Map([['TEST', artificialFacts()]]) };
  const result = await syncFinancialsFromSec(environment, 'TEST');
  return { ...store, environment, result };
}

test('전체 SEC 저장 경로는 숫자·reported_date를 유지하고 지표별 원본과 계산 입력을 저장한다', async () => {
  const { sqlite, result } = await syncedDatabase();
  try {
    const row = sqlite.prepare(`SELECT revenue,operating_income,net_income,eps,free_cash_flow,roe,
      gross_margin,operating_margin,reported_date,fiscal_year,fiscal_period,period_start
      FROM financial_metrics WHERE period_type='quarterly' AND fiscal_period_end='2026-07-26'`).get();
    assert.deepEqual({ ...row }, { revenue: 100, operating_income: 30, net_income: 20, eps: 0.4,
      free_cash_flow: 33, roe: 10, gross_margin: 70, operating_margin: 30, reported_date: '2026-08-26',
      fiscal_year: 2027, fiscal_period: 'Q2', period_start: '2026-04-27' });
    const annual = sqlite.prepare(`SELECT revenue,operating_income,net_income,eps,free_cash_flow,roe,
      gross_margin,operating_margin FROM financial_metrics WHERE period_type='annual'`).get();
    assert.deepEqual({ ...annual }, { revenue: 1000, operating_income: 300, net_income: 200, eps: 4,
      free_cash_flow: 200, roe: 20, gross_margin: 75, operating_margin: 30 });
    const q4 = sqlite.prepare(`SELECT eps,fiscal_year,fiscal_period,period_start FROM financial_metrics
      WHERE period_type='quarterly' AND fiscal_period_end='2026-01-25'`).get();
    assert.deepEqual({ ...q4 }, { eps: null, fiscal_year: 2026, fiscal_period: 'Q4', period_start: '2025-10-27' });
    const rows = sqlite.prepare(`SELECT * FROM financial_metric_provenance WHERE period_type='quarterly'
      AND fiscal_period_end='2026-07-26'`).all();
    const byMetric = Object.fromEntries(rows.map(record => [record.metric_name, record]));
    assert.equal(byMetric.revenue.calculation_type, 'direct');
    assert.equal(byMetric.eps.unit, 'USD/shares');
    assert.equal(byMetric.operating_cash_flow.calculation_type, 'ytd_difference');
    assert.equal(byMetric.free_cash_flow.calculation_type, 'derived');
    assert.equal(byMetric.free_cash_flow.form, null);
    const refs = JSON.parse(byMetric.free_cash_flow.source_refs_json);
    assert.equal(refs.length, 4);
    assert.deepEqual(refs.map(ref => ref.value), [60, 20, 10, 3]);
    assert.ok(refs.every(ref => ref.tag && ref.form && ref.accession && ref.filed && ref.start && ref.end && ref.unit));
    assert.equal(JSON.parse(byMetric.roe.calculation_details_json).formula, 'net_income / stockholders_equity * 100');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM financial_metric_provenance WHERE metric_name IN ('net_margin','roic','pe_ratio','ps_ratio','peg_ratio')").get().n, 0);
    assert.equal(result.metadataVersion, 1);
    assert.ok(result.metadataCoverage.provenance > 0);
  } finally { sqlite.close(); }
});

test('반복 SEC 처리의 수치·최종 출처는 동일하고 중복 출처 행이 생기지 않는다', async () => {
  const { sqlite, environment } = await syncedDatabase();
  try {
    const query = `SELECT * FROM financial_metric_provenance ORDER BY period_type,fiscal_period_end,metric_name`;
    // 재수집 시각은 바뀔 수 있으므로 값·기간·출처의 의미만 비교한다.
    const semanticRows = rows => rows.map(({ updated_at, cached_at, ...row }) => row);
    const before = semanticRows(sqlite.prepare(query).all());
    const values = semanticRows(sqlite.prepare('SELECT * FROM financial_metrics ORDER BY period_type,fiscal_period_end').all());
    await syncFinancialsFromSec(environment, 'TEST');
    assert.deepEqual(semanticRows(sqlite.prepare(query).all()), before);
    assert.deepEqual(semanticRows(sqlite.prepare('SELECT * FROM financial_metrics ORDER BY period_type,fiscal_period_end').all()), values);
  } finally { sqlite.close(); }
});

test('기존 수집 작업은 같은 accession도 새 출처 버전으로 한 번 재처리한 후 생략한다', async t => {
  const { sqlite, DB } = database();
  const environment = { DB };
  try {
    await ensureFundamentalStore(environment);
    sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('TEST','검증용 회사','1');
      INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','TEST','price',0);
      INSERT INTO fundamental_jobs(ticker,kind,status,next_run_at) VALUES ('TEST','profile','ready','2099-01-01');
      INSERT INTO fundamental_jobs(ticker,kind,status,details) VALUES ('TEST','financials','ready',
        '{"source":"SEC EDGAR","annualCount":1,"quarterlyCount":1}');
      INSERT INTO sec_filing_checks(ticker,accession) VALUES ('TEST','test-q2');`);
    let factsCalls = 0;
    t.mock.method(globalThis, 'fetch', async url => {
      if (String(url).includes('/submissions/')) return Response.json({ filings: { recent: {
        form: ['10-Q'], accessionNumber: ['test-q2'], reportDate: ['2026-07-26']
      } } });
      if (String(url).includes('/companyfacts/')) {
        factsCalls += 1;
        return Response.json({ facts: artificialFacts() });
      }
      throw new Error('검증 범위 밖 API 요청');
    });
    const first = await runFundamentalBatch(environment, 'TEST');
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].status, 'ready');
    assert.equal(first.results[0].details.metadataVersion, 1);
    assert.equal(factsCalls, 1);
    assert.ok(sqlite.prepare('SELECT COUNT(*) AS n FROM financial_metric_provenance').get().n > 0);
    sqlite.exec("UPDATE fundamental_jobs SET next_run_at=NULL WHERE ticker='TEST' AND kind='financials'");
    const second = await runFundamentalBatch(environment, 'TEST');
    assert.equal(second.results[0].status, 'ready');
    assert.equal(factsCalls, 1);
  } finally { sqlite.close(); }
});

test('SEC 원본 HTTP 403이면 기존 값·NULL 기간·출처를 변경하지 않는다', async t => {
  const { sqlite, DB } = database();
  try {
    sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('NVDA','NVIDIA Corporation','1045810');
      INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,eps,source)
        VALUES ('NVDA','quarterly','2026-07-26',96221000000,2.46,'SEC EDGAR');`);
    const before = sqlite.prepare('SELECT * FROM financial_metrics').all();
    t.mock.method(globalThis, 'fetch', async () => new Response('검증용 접근 거부', { status: 403 }));
    await assert.rejects(syncFinancialsFromSec({ DB, secFacts: new Map() }, 'NVDA'), /HTTP 403/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM financial_metrics').all(), before);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM financial_metric_provenance').get().n, 0);
  } finally { sqlite.close(); }
});

test('source write가 실패하면 같은 기간의 부모 숫자와 provenance를 함께 롤백한다', async () => {
  const { sqlite, environment } = await syncedDatabase();
  try {
    const before = sqlite.prepare('SELECT * FROM financial_metrics ORDER BY period_type,fiscal_period_end').all();
    const sources = sqlite.prepare('SELECT * FROM financial_metric_provenance ORDER BY period_type,fiscal_period_end,metric_name').all();
    sqlite.exec(`CREATE TRIGGER fail_provenance BEFORE INSERT ON financial_metric_provenance
      BEGIN SELECT RAISE(ABORT,'출처 저장 실패 검증'); END;`);
    await assert.rejects(syncFinancialsFromSec(environment, 'TEST'), /출처 저장 실패 검증/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM financial_metrics ORDER BY period_type,fiscal_period_end').all(), before);
    assert.deepEqual(sqlite.prepare('SELECT * FROM financial_metric_provenance ORDER BY period_type,fiscal_period_end,metric_name').all(), sources);
  } finally { sqlite.close(); }
});

test('기간이 제거되거나 지표가 NULL로 바뀌면 해당 최종 출처도 정리된다', async () => {
  const { sqlite, environment } = await syncedDatabase();
  try {
    const facts = artificialFacts();
    facts['us-gaap'].EarningsPerShareDiluted.units['USD/shares'] = [];
    for (const entry of Object.values(facts['us-gaap'])) {
      for (const unit of Object.keys(entry.units)) {
        entry.units[unit] = entry.units[unit].filter(row => row.end !== '2026-04-26');
      }
    }
    environment.secFacts.set('TEST', facts);
    await syncFinancialsFromSec(environment, 'TEST');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM financial_metric_provenance WHERE metric_name='eps' OR fiscal_period_end='2026-04-26'").get().n, 0);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('회사 API는 기존 financials 필드를 유지하고 기간 3개 필드만 덧붙인다', async t => {
  const { sqlite, environment } = await syncedDatabase();
  try {
    await ensureFundamentalStore(environment);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('조회 경로에서 외부 API를 호출하면 안 됩니다.'); });
    const response = await worker.fetch(new Request('https://example.test/api/companies/TEST'), environment);
    assert.equal(response.status, 200);
    const company = (await response.json()).company;
    const row = company.financials.find(item => item.periodType === 'quarterly' && item.fiscalPeriodEnd === '2026-07-26');
    for (const field of ['periodType', 'fiscalPeriodEnd', 'reportedDate', 'revenue', 'operatingIncome', 'netIncome',
      'eps', 'pegRatio', 'peRatio', 'psRatio', 'freeCashFlow', 'roe', 'roic', 'grossMargin', 'operatingMargin', 'source', 'cachedAt']) {
      assert.ok(field in row);
    }
    assert.equal(row.fiscalYear, 2027);
    assert.equal(row.fiscalPeriod, 'Q2');
    assert.equal(row.periodStart, '2026-04-27');
    assert.equal('provenance' in row, false);
    assert.equal('dividendMetrics' in company, true);
    assert.equal('candles' in company, true);
  } finally { sqlite.close(); }
});
