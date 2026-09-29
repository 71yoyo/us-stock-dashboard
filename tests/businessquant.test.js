import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseBusinessQuantResponse, calculateBusinessQuantMetrics,
  inferDividendFrequency, estimateNextExDate } from '../worker/src/businessquant-metrics.js';
import { businessQuantDividendView } from '../worker/src/businessquant-view.js';
import { diffBusinessQuantRows, syncBusinessQuantTicker,
  reserveBusinessQuantCall, nextBusinessQuantTicker,
  runMassiveDividendCheck, runDividendPipeline,
  refreshStoredDividendDates } from '../worker/src/businessquant-sync.js';

const date = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
function events(count, gap, start = '2003-11-26', amount = 0.25) {
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const exDate = new Date(first + index * gap * 86_400_000).toISOString().slice(0, 10);
    return { exDate, paymentDate: new Date(first + (index * gap + 15) * 86_400_000).toISOString().slice(0, 10), dividend: amount };
  });
}

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../worker/migrations/0014_businessquant_dividends.sql', import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE massive_dividend_events(ticker TEXT, provider_event_id TEXT,
    declaration_date TEXT, ex_dividend_date TEXT, record_date TEXT, payment_date TEXT,
    amount REAL, split_adjusted_amount REAL, distribution_type TEXT, frequency INTEGER,
    source_updated_at TEXT, PRIMARY KEY(ticker,provider_event_id));
    CREATE TABLE massive_api_budget(minute TEXT PRIMARY KEY, calls INTEGER NOT NULL);
    CREATE TABLE user_watchlist(user_id TEXT, ticker TEXT, display_order INTEGER);`);
  const wrap = statement => ({
    bind(...values) {
      const prepared = statement;
      return {
        first: async () => prepared.get(...values) || null,
        all: async () => ({ results: prepared.all(...values) }),
        run: async () => prepared.run(...values)
      };
    }
  });
  const db = { prepare: query => wrap(sqlite.prepare(query)),
    batch: async statements => {
      const output = [];
      for (const statement of statements) output.push(await statement.all?.() ?? await statement.run?.());
      return output;
    } };
  return { sqlite, db };
}

test('parser는 전체 275건을 보존하고 빈 응답·중복 날짜·손상 필드는 거부한다', () => {
  const rows = events(275, 30);
  const payload = { metadata: { ticker: 'O', divyield: 5.83 }, data: rows.map(row => ({
    ex_date: row.exDate, payment_date: row.paymentDate, dividend: row.dividend })) };
  assert.equal(parseBusinessQuantResponse(payload, 'O').events.length, 275);
  assert.throws(() => parseBusinessQuantResponse({ ...payload, data: [] }, 'O'));
  assert.throws(() => parseBusinessQuantResponse({ ...payload, data: [...payload.data, payload.data[0]] }, 'O'));
  assert.throws(() => parseBusinessQuantResponse({ ...payload, data: [{ dividend: 1 }] }, 'O'));
});

test('월·분기·반기·연·비정기 판별과 월·분기 다음 내부 추정', () => {
  assert.equal(inferDividendFrequency(events(12, 30)).label, '월');
  assert.equal(inferDividendFrequency(events(8, 91)).label, '분기');
  assert.equal(inferDividendFrequency(events(8, 182)).label, '반기');
  assert.equal(inferDividendFrequency(events(8, 365)).label, '연');
  const irregular = events(8, 91);
  irregular[2].exDate = '2004-05-01';
  irregular[4].exDate = '2005-02-01';
  assert.equal(inferDividendFrequency(irregular).label, '비정기');
  assert.ok(estimateNextExDate(events(12, 30), '2004-11-01'));
  assert.ok(estimateNextExDate(events(8, 91), '2005-11-01'));
});

test('지급일 기준 최근 365일, 마지막 지급, 미래 배당락·금액·지급일을 분리한다', () => {
  const rows = [
    { exDate: '2025-09-27', paymentDate: '2025-10-01', dividend: 1 },
    { exDate: '2026-01-01', paymentDate: '2026-01-15', dividend: 2 },
    { exDate: '2026-09-20', paymentDate: '2026-10-15', dividend: 3 },
    { exDate: '2026-10-01', paymentDate: '2026-10-20', dividend: 4 }
  ];
  const result = calculateBusinessQuantMetrics(rows, [], '2026-09-29');
  assert.equal(result.paidDividend1y, 3);
  assert.equal(result.lastPaidDividend, 2);
  assert.equal(result.nextExDate, '2026-10-01');
  assert.equal(result.nextDividend, 4);
  assert.equal(result.nextPaymentDate, '2026-10-20');
});

test('완료 지급연도 DPS로 1·5·10년 성장률과 확보 이력 내 성장연수를 계산한다', () => {
  const rows = [];
  for (let year = 2013; year <= 2025; year += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) rows.push({
      exDate: date(year, 1 + quarter * 3, 15), paymentDate: date(year, 1 + quarter * 3, 25),
      dividend: 0.25 * Math.pow(1.1, year - 2013)
    });
  }
  rows.push({ exDate: '2026-01-15', paymentDate: '2026-01-25', dividend: 100 });
  const result = calculateBusinessQuantMetrics(rows, [], '2026-09-29');
  assert.ok(Math.abs(result.growthRate1y - 10) < 1e-8);
  assert.ok(Math.abs(result.growthRate5y - 10) < 1e-8);
  assert.ok(Math.abs(result.growthRate10y - 10) < 1e-8);
  assert.equal(result.growthYearsAvailableHistory, 12);
  const short = calculateBusinessQuantMetrics(rows.filter(row => row.exDate >= '2022-01-01'), [], '2026-09-29');
  assert.equal(short.growthRate5y, null);
});

test('월배당의 배당락일 11회·13회 착시를 지급연도 12회씩으로 바로잡는다', () => {
  const rows = [];
  // 월초 배당락과 전월 말 배당락이 섞여도 각 지급연도에는 정확히 12회다.
  const ex2024 = ['2024-01-31', '2024-02-29', '2024-03-28', '2024-04-30',
    '2024-06-03', '2024-07-01', '2024-08-01', '2024-09-03',
    '2024-10-01', '2024-11-01', '2024-12-02'];
  const ex2025 = ['2025-01-02', '2025-02-03', '2025-03-03', '2025-04-01',
    '2025-05-01', '2025-06-02', '2025-07-01', '2025-08-01',
    '2025-09-02', '2025-10-01', '2025-10-31', '2025-11-28', '2025-12-31'];
  rows.push({ exDate: '2023-12-29', paymentDate: '2024-01-15', dividend: 0.25 });
  for (let index = 0; index < ex2024.length; index += 1) rows.push({
    exDate: ex2024[index], paymentDate: date(2024, index + 2, 15), dividend: 0.25
  });
  for (let index = 0; index < ex2025.length; index += 1) rows.push({
    exDate: ex2025[index], paymentDate: index === 12 ? '2026-01-15'
      : date(2025, index + 1, 15), dividend: 0.25
  });
  const result = calculateBusinessQuantMetrics(rows, [], '2026-09-29');
  assert.equal(result.dividendFrequency, '월');
  assert.equal(result.growthRate1y, 0);
  assert.match(result.specialFilterNote, /지급연도별 정기배당 횟수 기준/);
});

test('신규 월·분기·반기 종목은 연간 정기 지급 횟수별로 1·5·10년을 계산한다', () => {
  for (const [frequency, months] of [['월', 12], ['분기', 4], ['반기', 2]]) {
    const rows = [];
    for (let year = 2014; year <= 2025; year += 1) {
      for (let index = 0; index < months; index += 1) {
        const month = 1 + index * (12 / months);
        rows.push({ exDate: date(year, month, 5), paymentDate: date(year, month, 15),
          dividend: 0.25 * Math.pow(1.04, year - 2014) });
      }
    }
    const result = calculateBusinessQuantMetrics(rows, [], '2026-09-29');
    assert.equal(result.dividendFrequency, frequency);
    for (const rate of [result.growthRate1y, result.growthRate5y, result.growthRate10y]) {
      assert.ok(Math.abs(rate - 4) < 1e-8, `${frequency}: ${rate}`);
    }
    // 지급 기록이 하나라도 빠지면 그 해가 포함된 성장률은 추정하지 않는다.
    const incomplete = calculateBusinessQuantMetrics(rows.filter(row =>
      row.paymentDate !== date(2025, 1, 15)), [], '2026-09-29');
    assert.equal(incomplete.growthRate1y, null);
    assert.equal(incomplete.growthRate5y, null);
    assert.equal(incomplete.growthRate10y, null);
  }
});

test('기존 요약도 외부 API 재호출 없이 새 성장률 방식으로 갱신한다', async () => {
  const { db, sqlite } = createD1();
  try {
    sqlite.exec(`INSERT INTO user_watchlist(user_id,ticker,display_order) VALUES ('primary','O',0);
      INSERT INTO bq_dividend_summary(ticker,fetch_status,history_count,
        growth_rate_1y,businessquant_updated_at)
      VALUES ('O','ready',24,22.03,'2026-09-28T00:00:00.000Z');`);
    const insert = sqlite.prepare(`INSERT INTO bq_dividend_history
      (ticker,ex_date,payment_date,dividend,source,first_seen_at,last_seen_at,fetched_at)
      VALUES ('O',?,?,?,'businessquant','2026-09-28','2026-09-28','2026-09-28')`);
    for (const year of [2024, 2025]) {
      for (let month = 1; month <= 12; month += 1) {
        insert.run(date(year, month, 1), date(year, month, 15), year === 2024 ? 0.25 : 0.26);
      }
    }
    assert.equal((await refreshStoredDividendDates({ DB: db }, '2026-09-29T00:00:00.000Z')).refreshed, 1);
    const summary = sqlite.prepare(`SELECT growth_rate_1y, dividend_frequency
      FROM bq_dividend_summary WHERE ticker='O'`).get();
    assert.equal(summary.dividend_frequency, '월');
    assert.ok(Math.abs(summary.growth_rate_1y - 4) < 1e-8);
  } finally { sqlite.close(); }
});

test('확인된 특별배당만 성장률에서 제외하고 BQ divyield를 100배 하지 않는다', () => {
  const rows = events(20, 91, '2021-01-01');
  rows.push({ exDate: '2024-10-01', paymentDate: '2024-10-15', dividend: 5 });
  rows.sort((a, b) => a.exDate.localeCompare(b.exDate));
  const special = [{ exDividendDate: '2024-10-01', distributionType: 'special' }];
  const filtered = calculateBusinessQuantMetrics(rows, special, '2026-01-01');
  const unfiltered = calculateBusinessQuantMetrics(rows, [], '2026-01-01');
  assert.ok(Number.isFinite(filtered.growthRate1y));
  assert.equal(unfiltered.growthRate1y, null);
  const view = businessQuantDividendView({ ticker: 'O', fetch_status: 'ready',
    paid_dividend_1y: 3.24, history_count: 275, next_ex_date: null }, 55.5, '저장 현재가');
  assert.ok(Math.abs(view.dividendYield - 5.8378378) < 0.001);
  assert.equal(view.nextExDividendDate, null);
});

test('분할 보정이 확인되지 않은 DPS 급변 구간의 5·10년 성장률은 단정하지 않는다', () => {
  const rows = [];
  for (let year = 2014; year <= 2025; year += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) rows.push({
      exDate: date(year, quarter * 3 + 1, 10), paymentDate: date(year, quarter * 3 + 1, 20),
      dividend: year < 2021 ? 0.8 : 0.2
    });
  }
  const metrics = calculateBusinessQuantMetrics(rows, [], '2026-09-29');
  assert.equal(metrics.growthRate5y, null);
  assert.equal(metrics.growthRate10y, null);
  assert.match(metrics.specialFilterNote, /DPS 급변/);
});

test('증분 비교는 신규·정정만 쓰고 공급원 누락은 삭제하지 않는다', () => {
  const old = events(274, 30);
  const received = [...old, events(275, 30).at(-1)];
  assert.deepEqual(Object.keys(diffBusinessQuantRows(old, received)),
    ['inserted', 'updated', 'unchanged', 'existing', 'received']);
  assert.equal(diffBusinessQuantRows(old, received).inserted.length, 1);
  assert.equal(diffBusinessQuantRows(old, old).unchanged, 274);
  const corrected = old.map((row, index) => index === 0 ? { ...row, dividend: 0.3 } : row);
  assert.equal(diffBusinessQuantRows(old, corrected).updated.length, 1);
  assert.equal(diffBusinessQuantRows(old, old.slice(1)).inserted.length, 0);
});

test('D1 24회 하드 한도와 같은 날 동일 티커 중복 호출 방지', async () => {
  const { db } = createD1();
  const now = '2026-09-29T12:00:00.000Z';
  assert.equal(await reserveBusinessQuantCall(db, 'O', now), true);
  assert.equal(await reserveBusinessQuantCall(db, 'O', now), false);
  for (let index = 1; index < 24; index += 1) assert.equal(await reserveBusinessQuantCall(db, `T${index}`, now), true);
  assert.equal(await reserveBusinessQuantCall(db, 'EXTRA', now), false);
  assert.equal(await reserveBusinessQuantCall(db, 'EXTRA', '2026-09-30T00:01:00.000Z'), false);
});

test('설정 호출량을 낮출 수 있지만 24회를 초과하도록 높일 수 없다', async () => {
  const { db, sqlite } = createD1();
  try {
    const now = '2026-09-29T12:00:00.000Z';
    assert.equal(await reserveBusinessQuantCall(db, 'A', now, 2), true);
    assert.equal(await reserveBusinessQuantCall(db, 'B', now, 2), true);
    assert.equal(await reserveBusinessQuantCall(db, 'C', now, 2), false);
  } finally { sqlite.close(); }
});

test('대기열은 Massive 새 선언을 신규 종목보다 먼저 고르고 당일 재호출은 이월한다', async () => {
  const { db, sqlite } = createD1();
  const now = '2026-09-29T12:00:00.000Z';
  try {
    sqlite.exec(`INSERT INTO user_watchlist(user_id,ticker,display_order)
      VALUES ('primary','O',0),('primary','JPM',1);
      INSERT INTO bq_dividend_summary(ticker,history_count,fetch_status,
        massive_dividend_event_detected_at,last_bq_fetch_at,next_bq_fetch_at)
      VALUES ('JPM',50,'ready','2026-09-29T11:00:00.000Z',
        '2026-09-28T00:00:00.000Z','2026-09-29T11:00:00.000Z');`);
    assert.equal((await nextBusinessQuantTicker(db, now))?.ticker, 'JPM');
    assert.equal(await reserveBusinessQuantCall(db, 'JPM', now), true);
    assert.equal((await nextBusinessQuantTicker(db, now))?.ticker, 'O');
  } finally { sqlite.close(); }
});

test('Massive 미래 선언 감지 시 BQ 우선순위를 올리고 같은 이벤트는 다시 알리지 않는다', async () => {
  const { db, sqlite } = createD1();
  const originalFetch = globalThis.fetch;
  sqlite.exec("INSERT INTO user_watchlist(user_id,ticker,display_order) VALUES ('primary','O',0)");
  globalThis.fetch = async () => Response.json({ results: [{ id: 'event-1', ex_dividend_date: '2099-01-01',
    declaration_date: '2026-09-29', pay_date: '2099-01-15', cash_amount: 0.5,
    distribution_type: 'recurring', frequency: 12 }] });
  try {
    const env = { DB: db, MASSIVE_API_KEY: 'test-only' };
    const first = await runMassiveDividendCheck(env, '2026-09-29T12:00:00.000Z');
    assert.equal(first.newDeclarations, 1);
    assert.equal(sqlite.prepare("SELECT fetch_priority AS priority FROM bq_dividend_summary WHERE ticker='O'").get().priority, 1);
    const second = await runMassiveDividendCheck(env, '2026-09-30T13:00:00.000Z');
    assert.equal(second.newDeclarations, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('파이프라인은 운영 활성화 설정 전에는 외부 호출과 DB 쓰기를 시작하지 않는다', async () => {
  const { db, sqlite } = createD1();
  try {
    assert.deepEqual(await runDividendPipeline({ DB: db, MASSIVE_API_KEY: 'test-only' }), { status: 'disabled' });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_api_budget').get().n, 0);
  } finally { sqlite.close(); }
});

test('실제 SQL로 275건 최초 적재, 동일 재수집 0건 쓰기, 신규·정정, 누락 보존', async () => {
  const { db, sqlite } = createD1();
  const originalFetch = globalThis.fetch;
  const rows = events(275, 30);
  let supplied = rows;
  globalThis.fetch = async () => new Response(JSON.stringify({ metadata: { ticker: 'O', divyield: 5.83,
    ttmdividend: 3.24 }, data: supplied.map(row => ({ dividend: row.dividend,
    ex_date: row.exDate, payment_date: row.paymentDate })) }), { status: 200 });
  try {
    const environment = { DB: db, BUSINESS_QUANT_API_KEY: 'test-only' };
    const first = await syncBusinessQuantTicker(environment, 'O', '2026-09-29T00:00:00.000Z');
    assert.equal(first.status, 'ready', first.error);
    assert.equal(first.inserted.length, 275);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM bq_dividend_history').get().total, 275);
    const second = await syncBusinessQuantTicker(environment, 'O', '2026-09-30T01:00:00.000Z');
    assert.equal(second.status, 'ready', second.error);
    assert.equal(second.unchanged, 275);
    supplied = [...rows, events(276, 30).at(-1)];
    const third = await syncBusinessQuantTicker(environment, 'O', '2026-10-01T02:00:00.000Z');
    assert.equal(third.inserted.length, 1);
    supplied = supplied.map((row, index) => index === 5 ? { ...row, dividend: 0.26 } : row);
    const fourth = await syncBusinessQuantTicker(environment, 'O', '2026-10-02T03:00:00.000Z');
    assert.equal(fourth.updated.length, 1);
    supplied = supplied.slice(1);
    const fifth = await syncBusinessQuantTicker(environment, 'O', '2026-10-03T04:00:00.000Z');
    assert.equal(fifth.status, 'ready', fifth.error);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM bq_dividend_history').get().total, 276);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('HTTP 403·429·5xx·빈 응답·schema 오류는 기존 이력을 보존한다', async () => {
  const { db, sqlite } = createD1();
  const originalFetch = globalThis.fetch;
  try {
    const environment = { DB: db, BUSINESS_QUANT_API_KEY: 'test-only' };
    for (const [index, [ticker, status]] of [['AA', 403], ['BB', 429], ['CC', 500]].entries()) {
      globalThis.fetch = async () => new Response('{}', { status });
      const result = await syncBusinessQuantTicker(environment, ticker, `2026-10-0${index + 1}T00:00:00.000Z`);
      assert.equal(result.httpStatus, status);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ metadata: { ticker: 'DD' }, data: [] }));
    const empty = await syncBusinessQuantTicker(environment, 'DD', '2026-10-04T00:00:00.000Z');
    assert.equal(empty.status, 'error');
    globalThis.fetch = async () => new Response(JSON.stringify({ wrong: true }));
    const malformed = await syncBusinessQuantTicker(environment, 'EE', '2026-10-05T00:00:00.000Z');
    assert.equal(malformed.status, 'error');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM bq_dividend_history').get().total, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('재수집 실패해도 마지막 정상 BQ 요약과 성공 시각을 유지한다', async () => {
  const { db, sqlite } = createD1();
  const originalFetch = globalThis.fetch;
  const environment = { DB: db, BUSINESS_QUANT_API_KEY: 'test-only' };
  const row = { ex_date: '2026-01-01', payment_date: '2026-01-15', dividend: 0.5 };
  try {
    globalThis.fetch = async () => Response.json({ metadata: { ticker: 'O' }, data: [row] });
    assert.equal((await syncBusinessQuantTicker(environment, 'O', '2026-09-29T00:00:00.000Z')).status, 'ready');
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    assert.equal((await syncBusinessQuantTicker(environment, 'O', '2026-09-30T01:00:00.000Z')).status, 'error');
    const summary = sqlite.prepare('SELECT * FROM bq_dividend_summary WHERE ticker=?').get('O');
    assert.equal(summary.fetch_status, 'ready');
    assert.equal(summary.last_bq_fetch_at, '2026-09-29T00:00:00.000Z');
    assert.equal(summary.history_count, 1);
    assert.equal(businessQuantDividendView(summary, 100)?.source, 'BUSINESS_QUANT');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});
