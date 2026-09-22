import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { latestSecValues, selectSecFacts, calculateDividendMetrics } from '../worker/src/fmp-sync.js';
import { runFundamentalBatch, fundamentalStatus } from '../worker/src/fundamental-sync.js';
import { ensureFundamentalStore, reserveFundamentalCall } from '../worker/src/fundamental-store.js';

// 실제 SQLite에서 D1과 같은 바인딩/트랜잭션으로 실행해 SQL과 동시 임대도 검증한다.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../worker/migrations/', import.meta.url)).sort()) {
    sqlite.exec(readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  function prepare(sql) {
    const statement = { sql, values: [], bind(...values) { this.values = values; return this; },
      async first() { return sqlite.prepare(sql).get(...this.values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
      async run() { return sqlite.prepare(sql).run(...this.values); }
    };
    return statement;
  }
  return { sqlite, DB: { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(item => ({ results: sqlite.prepare(item.sql).all(...item.values) }));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } };
}

const record = (start, end, val, extra = {}) => ({ start, end, val, form: '10-Q', fp: 'Q2', fy: 2026,
  filed: '2026-08-01', accn: 'new-filing', ...extra });

test('SEC 태그 전환, 누적 현금흐름 분리, 연간/Q4 구분', () => {
  const entries = selectSecFacts({ 'us-gaap': {
    Revenues: { units: { USD: [record('2026-01-01', '2026-03-31', 10), record('2026-01-01', '2026-06-30', 25)] } },
    SalesRevenueNet: { units: { USD: [record('2025-01-01', '2025-12-31', 80, { form: '10-K', fp: 'FY' }),
      record('2025-01-01', '2025-09-30', 50), record('2025-10-01', '2025-12-31', 30, { form: '10-K', fp: 'FY' })] } }
  } }, ['Revenues', 'SalesRevenueNet'], ['USD']);
  const forms = ['10-Q', '10-K'];
  const quarterly = latestSecValues(entries, forms, 2025, 'quarterly');
  assert.equal(quarterly.get('2026-06-30').val, 15);
  assert.equal(quarterly.get('2025-12-31').val, 30);
  const annual = latestSecValues(entries, forms, 2025, 'annual');
  assert.equal(annual.size, 1);
  assert.equal(annual.get('2025-12-31').val, 80);
});

test('배당은 진행 중인 연도/미래분을 연간 합계에 넣지 않고 10년 미확보는 null', () => {
  const metrics = calculateDividendMetrics([
    { exDividendDate: '2025-03-01', amount: 1 }, { exDividendDate: '2025-12-01', amount: 1 },
    { exDividendDate: '2026-07-01', amount: .2 }, { exDividendDate: '2026-08-01', amount: .2 },
    { exDividendDate: '2026-09-01', amount: .2 }, { exDividendDate: '2026-10-01', amount: .2 }
  ], 100, '2026-09-22');
  assert.equal(metrics.annualDividend, 2);
  assert.ok(Math.abs(metrics.quarterlyDividend - .6) < 1e-9);
  assert.equal(metrics.growthCagr, null);
  assert.equal(metrics.nextExDate, '2026-10-01');
});

test('전체 수집은 시세/차트 미호출, SEC 한 번 재사용, 새 공시 없으면 원문 미호출, 실패 제한 유지', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('O','O','726728'),('JPM','JPM','19617');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0),('primary','JPM','dividend',1);
    INSERT INTO price_quotes(ticker,current_price) VALUES ('O',100);`);
  const unit = rows => ({ units: { USD: rows } });
  const values = [record('2025-01-01', '2025-12-31', 100, { form: '10-K', fp: 'FY' }), record('2026-04-01', '2026-06-30', 30)];
  const facts = { 'us-gaap': { Revenues: unit(values), NetIncomeLoss: unit(values),
    CommonStockDividendsPerShareDeclared: { units: { 'USD/shares': values } } } };
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url);
    if (url.includes('/submissions/')) return Response.json({ filings: { recent: { form: ['10-Q'], accessionNumber: ['new-filing'], reportDate: ['2026-06-30'] } } });
    if (url.includes('/companyfacts/')) return Response.json({ facts });
    if (url.includes('/dividends?')) return new Response('plan restricted', { status: 402 });
    throw new Error('예상하지 않은 외부 요청');
  };
  try {
    const env = { DB, MARKET_DATA_API_KEY: 'test-only' };
    const batches = await Promise.all([runFundamentalBatch(env), runFundamentalBatch(env)]);
    assert.equal(urls.filter(url => url.includes('/companyfacts/')).length, 2);
    assert.equal(urls.some(url => /quote|historical-price/.test(url)), false);
    assert.equal(sqlite.prepare('SELECT current_price FROM price_quotes WHERE ticker=?').get('O').current_price, 100);
    const status = await fundamentalStatus({ DB });
    assert.equal(status.summary.financials.stored, 2);
    assert.equal(status.summary.dividends.stored, 2);
    // 5-3은 재무 작업과 별개로 D1에 저장된 최신 현재가도 같은 종목 행에서 보여 준다.
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').price.currentPrice, 100);
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').price.status, 'ready');
    assert.ok(batches.flatMap(batch => batch.results).every(row => row.status !== 'error'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dividend_periods').get().n, 4);
    const before = urls.length;
    await runFundamentalBatch(env);
    assert.equal(urls.length, before);
    sqlite.exec("UPDATE fundamental_jobs SET next_run_at=NULL WHERE kind='financials'");
    await runFundamentalBatch(env);
    assert.equal(urls.filter(url => url.includes('/companyfacts/')).length, 2);
    assert.equal(urls.filter(url => url.includes('/submissions/')).length, 4);
    await assert.rejects(reserveFundamentalCall({ DB }, 'dividends', 'O'), /402/);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('FMP 부가 데이터 예산은 병렬 요청에도 150회를 초과하지 않는다', async () => {
  const { DB, sqlite } = database();
  const env = { DB };
  await ensureFundamentalStore(env);
  sqlite.prepare('INSERT INTO fundamental_api_budget(day,calls) VALUES (?,149)').run(new Date().toISOString().slice(0,10));
  const outcomes = await Promise.allSettled([reserveFundamentalCall(env, 'profile', 'O'), reserveFundamentalCall(env, 'profile', 'JPM')]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare('SELECT calls FROM fundamental_api_budget').get().calls, 150);
  sqlite.close();
});
