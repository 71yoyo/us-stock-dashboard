import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { latestSecValues, selectSecFacts, syncTickerFromFmp } from '../worker/src/fmp-sync.js';
import { runFundamentalBatch, fundamentalStatus, summarizeSecDividendPeriods } from '../worker/src/fundamental-sync.js';
import { ensureFundamentalStore, reserveFundamentalCall } from '../worker/src/fundamental-store.js';
import worker from '../worker/src/index.js';
import { combineDividendData } from '../worker/src/dividend-view.js';

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

test('분기배당 수익률은 최근 실제 지급 4회를 현재가로 나누고 미래 지급분은 제외한다', () => {
  const metrics = combineDividendData(null, [
    { source: 'MASSIVE', exDividendDate: '2025-12-01', paymentDate: '2025-12-15', amount: .5 },
    { source: 'MASSIVE', exDividendDate: '2026-03-01', paymentDate: '2026-03-15', amount: .5 },
    { source: 'MASSIVE', exDividendDate: '2026-06-01', paymentDate: '2026-06-15', amount: .6 },
    { source: 'MASSIVE', exDividendDate: '2026-09-01', paymentDate: '2026-09-15', amount: .6 },
    { source: 'MASSIVE', exDividendDate: '2026-12-01', paymentDate: '2026-12-15', amount: .7 }
  ], 100, '2026-09-22');
  assert.ok(Math.abs(metrics.annualDividend - 2.2) < 1e-9);
  assert.ok(Math.abs(metrics.quarterlyDividend - .6) < 1e-9);
  assert.ok(Math.abs(metrics.dividendYield - 2.2) < 1e-9);
  assert.equal(metrics.trailingPayoutCount, 4);
  assert.equal(metrics.dividendGrowthCagr10y, null);
  assert.equal(metrics.nextExDividendDate, '2026-12-01');
});

test('월배당 수익률은 최근 실제 지급 12회를 합산한다', () => {
  const events = Array.from({ length: 13 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 11 + index, 1));
    const isoDate = date.toISOString().slice(0, 10);
    return { source: 'MASSIVE', exDividendDate: isoDate,
      paymentDate: `${isoDate.slice(0, 8)}15`, amount: .1, distributionType: 'recurring', frequency: 12 };
  });
  const metrics = combineDividendData(null, events, 24, '2026-01-01');
  assert.ok(Math.abs(metrics.annualDividend - 1.2) < 1e-9);
  assert.ok(Math.abs(metrics.dividendYield - 5) < 1e-9);
  assert.equal(metrics.trailingPayoutCount, 12);
});

test('SEC 재무·10년 배당 통계는 FMP 키 없이 저장하며 Massive 이벤트는 별도로 확인한다', async () => {
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
    throw new Error('예상하지 않은 외부 요청');
  };
  try {
    const env = { DB };
    const batches = await Promise.all([runFundamentalBatch(env), runFundamentalBatch(env)]);
    assert.equal(urls.filter(url => url.includes('/companyfacts/')).length, 2);
    assert.equal(urls.some(url => url.includes('financialmodelingprep.com')), false);
    assert.equal(sqlite.prepare('SELECT current_price FROM price_quotes WHERE ticker=?').get('O').current_price, 100);
    const status = await fundamentalStatus({ DB });
    assert.equal(status.summary.financials.stored, 2);
    assert.equal(status.summary.dividends.stored, 0);
    assert.ok(status.jobs.filter(job => ['financials', 'dividends'].includes(job.kind))
      .every(job => job.status === 'ready' && job.details.source === 'SEC EDGAR'));
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').dividendEvents.status, 'pending');
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
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM fundamental_api_budget').get().n, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('기존 SEC 배당 기간 이력은 지급일·수익률을 만들지 않고 연간·분기액만 요약한다', () => {
  const metrics = summarizeSecDividendPeriods([
    { periodType: 'annual', periodEnd: '2024-12-31', amount: 2, source: 'SEC EDGAR' },
    { periodType: 'annual', periodEnd: '2025-12-31', amount: 2.4, source: 'SEC EDGAR' },
    { periodType: 'quarterly', periodEnd: '2026-06-30', amount: .63, source: 'SEC EDGAR' },
    { periodType: 'quarterly', periodEnd: '2026-09-30', amount: 9, source: 'FMP' }
  ]);
  assert.equal(metrics.annualDividend, 2.4);
  assert.equal(metrics.quarterlyDividend, .63);
  assert.equal(metrics.dividendGrowthYears, 1);
  assert.equal(metrics.dividendYield, null);
  assert.equal(metrics.nextExDividendDate, null);
  assert.equal(metrics.source, 'SEC EDGAR');
});

test('SEC 성장 통계와 Massive 실제 지급 1년·확정 일정을 결합한다', () => {
  const sec = summarizeSecDividendPeriods([
    { periodType: 'annual', periodEnd: '2025-12-31', amount: 3.2, source: 'SEC EDGAR' },
    { periodType: 'quarterly', periodEnd: '2026-06-30', amount: .8, source: 'SEC EDGAR' }
  ]);
  const result = combineDividendData(sec, [
    { source: 'MASSIVE', exDividendDate: '2025-11-01', paymentDate: '2025-11-15', amount: .7, adjustedAmount: .7, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-02-01', paymentDate: '2026-02-15', amount: .8, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-05-01', paymentDate: '2026-05-15', amount: .8, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-08-01', paymentDate: '2026-08-15', amount: .8, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-11-01', paymentDate: '2026-11-15', declarationDate: '2026-09-01', amount: .9, distributionType: 'recurring', frequency: 4 },
    { source: 'legacy', exDividendDate: '2026-07-01', paymentDate: '2026-07-15', amount: 99 }
  ], 100, '2026-09-23');
  assert.equal(result.secAnnualDividend, 3.2);
  assert.equal(result.secQuarterlyDividend, .8);
  assert.ok(Math.abs(result.annualDividend - 3.1) < 1e-9);
  assert.equal(result.quarterlyDividend, .8);
  assert.ok(Math.abs(result.dividendYield - 3.1) < 1e-9);
  assert.equal(result.lastPaidAmount, .8);
  assert.equal(result.nextExDividendDate, '2026-11-01');
  assert.equal(result.nextDateStatus, 'confirmed');
  assert.equal(result.eventCount, 5);
  assert.equal(result.frequency, 4);
  assert.equal(combineDividendData(sec, [], 100, '2026-09-23').dividendYield, null);
  assert.equal(combineDividendData(sec, [{ source: 'MASSIVE', exDividendDate: '2026-08-01', amount: .8 }], 100, '2026-09-23').dividendYield, null);
});

test('미래 공시가 없으면 월배당 전월 이력 또는 전년 이력만 예상으로 표시한다', () => {
  const monthly = combineDividendData(null, [
    { source: 'MASSIVE', exDividendDate: '2026-06-15', paymentDate: '2026-06-30', amount: .1, distributionType: 'recurring', frequency: 12 },
    { source: 'MASSIVE', exDividendDate: '2026-07-15', paymentDate: '2026-07-30', amount: .1, distributionType: 'recurring', frequency: 12 },
    { source: 'MASSIVE', exDividendDate: '2026-08-15', paymentDate: '2026-08-30', amount: .1, distributionType: 'recurring', frequency: 12 }
  ], 100, '2026-09-23');
  assert.equal(monthly.nextExDividendDate, '2026-10-15');
  assert.equal(monthly.nextDateStatus, 'estimated');
  const quarterly = combineDividendData(null, [
    { source: 'MASSIVE', exDividendDate: '2025-11-01', paymentDate: '2025-11-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-02-01', paymentDate: '2026-02-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-05-01', paymentDate: '2026-05-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-08-01', paymentDate: '2026-08-15', amount: .5, distributionType: 'recurring', frequency: 4 }
  ], 100, '2026-09-23');
  assert.equal(quarterly.nextExDividendDate, '2026-11-01');
  assert.equal(quarterly.nextDateStatus, 'estimated');
});

test('Massive 배당 필드를 저장하고 실패 시 이전 이벤트와 SEC 장기 이력을 보존한다', async () => {
  const { DB, sqlite } = database();
  await ensureFundamentalStore({ DB });
  sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('O','Realty Income','726728');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO price_quotes(ticker,current_price) VALUES ('O',100);
    INSERT INTO dividend_periods(ticker,period_type,period_end,amount,source)
      VALUES ('O','annual','2025-12-31',3.2,'SEC EDGAR');`);
  const originalFetch = globalThis.fetch;
  let blocked = false;
  globalThis.fetch = async (input, options) => {
    assert.match(String(input), /api\.massive\.com\/stocks\/v1\/dividends\?/);
    assert.equal(options.headers.Authorization, 'Bearer test-massive');
    return blocked ? new Response('restricted', { status: 429 }) : Response.json({ status: 'OK', results: [
      { id: 'event-1', ticker: 'O', ex_dividend_date: '2026-08-01', pay_date: '2026-08-15', cash_amount: .8,
        split_adjusted_cash_amount: .8, distribution_type: 'recurring', frequency: 12 },
      { id: 'event-2', ticker: 'O', ex_dividend_date: '2026-11-01', pay_date: '2026-11-15',
        declaration_date: '2026-09-01', cash_amount: .9, distribution_type: 'recurring', frequency: 12 }
    ] });
  };
  try {
    const environment = { DB, APP_PIN: 'test-pin', MASSIVE_API_KEY: 'test-massive' };
    assert.equal((await syncTickerFromFmp(environment, 'O', ['dividends'])).dividends, 'ok');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 2);
    assert.equal(sqlite.prepare("SELECT frequency, distribution_type AS type FROM massive_dividend_events WHERE provider_event_id='event-1'").get().frequency, 12);
    assert.equal(sqlite.prepare('SELECT amount FROM dividend_periods WHERE ticker=?').get('O').amount, 3.2);
    blocked = true;
    assert.match((await syncTickerFromFmp(environment, 'O', ['dividends'])).dividends, /429/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 2);
    const response = await worker.fetch(new Request('https://example.test/api/companies/O'), environment);
    const { company } = await response.json();
    assert.equal(company.dividendMetrics.secAnnualDividend, 3.2);
    assert.equal(company.dividendMetrics.annualDividend, .8);
    assert.equal(company.dividendMetrics.nextDateStatus, 'confirmed');
    assert.equal(company.dividendMetrics.frequency, 12);
    assert.equal(company.dividends.length, 2);
    const dashboardResponse = await worker.fetch(new Request('https://example.test/api/dashboard', {
      headers: { 'X-App-Pin': 'test-pin' }
    }), environment);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.stocks[0].dividendMetrics.secAnnualDividend, 3.2);
    assert.ok(Math.abs(dashboard.stocks[0].dividendMetrics.dividendYield - .8) < 1e-9);
    assert.equal(dashboard.stocks[0].dividendMetrics.nextExDividendDate, '2026-11-01');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('대시보드와 상세 화면은 Massive 외 레거시 이벤트를 제외하고 SEC 통계를 유지한다', async () => {
  const { DB, sqlite } = database();
  await ensureFundamentalStore({ DB });
  sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('O','Realty Income','726728');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO dividend_periods(ticker,period_type,period_end,amount,source)
      VALUES ('O','annual','2025-12-31',3.217,'SEC EDGAR'),('O','quarterly','2026-06-30',0.8115,'SEC EDGAR');
    INSERT INTO dividend_metrics(ticker,annual_dividend,dividend_yield,next_ex_dividend_date,next_date_status)
      VALUES ('O',99,25,'2026-10-01','confirmed');
    INSERT INTO dividend_events(ticker,ex_dividend_date,amount) VALUES ('O','2026-08-01',9);
    INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source)
      VALUES ('O','quarterly','2026-06-30',1547711000,'SEC EDGAR'),
             ('O','annual','2025-12-31',999,'FMP');
    INSERT INTO fundamental_jobs(ticker,kind,status,details)
      VALUES ('O','financials','partial','{"source":"SEC EDGAR","annualCount":1,"quarterlyCount":1}'),
             ('O','dividends','partial','{"source":"SEC EDGAR","annualCount":1,"quarterlyCount":1}');`);
  const environment = { DB, APP_PIN: 'test-pin' };
  try {
    const dashboardResponse = await worker.fetch(new Request('https://example.test/api/dashboard', {
      headers: { 'X-App-Pin': 'test-pin' }
    }), environment);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.stocks[0].dividendMetrics.secAnnualDividend, 3.217);
    assert.equal(dashboard.stocks[0].dividendMetrics.annualDividend, null);
    assert.equal(dashboard.stocks[0].dividendMetrics.dividendYield, null);
    assert.equal(dashboard.stocks[0].dividendMetrics.nextExDividendDate, null);

    const detailResponse = await worker.fetch(new Request('https://example.test/api/companies/O'), environment);
    assert.equal(detailResponse.status, 200);
    const { company } = await detailResponse.json();
    assert.equal(company.dividends.length, 0);
    assert.equal(company.dividendMetrics.secAnnualDividend, 3.217);
    assert.equal(company.dividendMetrics.secQuarterlyDividend, .8115);
    assert.equal(company.financials.length, 1);
    assert.equal(company.financials[0].source, 'SEC EDGAR');

    const status = await fundamentalStatus(environment);
    assert.ok(status.jobs.filter(job => ['financials', 'dividends'].includes(job.kind))
      .every(job => job.status === 'ready'));
    assert.equal(status.summary.dividends.stored, 0);
  } finally { sqlite.close(); }
});

test('FMP 일봉 402는 Massive로 보완하고 다음 요청에서는 FMP 402를 반복하지 않는다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input); requests.push(url);
    if (url.includes('financialmodelingprep.com')) return new Response('restricted', { status: 402 });
    assert.equal(options.headers.Authorization, 'Bearer test-massive');
    assert.match(url, /\/v2\/aggs\/ticker\/O\/range\/1\/day\//);
    return Response.json({ status: 'OK', results: [
      { t: Date.parse('2026-09-21T04:00:00Z'), o: 55, h: 56, l: 54, c: 55.5, v: 1000 },
      { t: Date.parse('2026-09-22T04:00:00Z'), o: 55.5, h: 57, l: 55, c: 56, v: 1100 }
    ] });
  };
  try {
    const env = { DB, MARKET_DATA_API_KEY: 'test-fmp', MASSIVE_API_KEY: 'test-massive' };
    assert.equal((await syncTickerFromFmp(env, 'O', ['candles'])).candles, 'ok');
    assert.equal((await syncTickerFromFmp(env, 'O', ['candles'])).candles, 'ok');
    assert.equal(requests.filter(url => url.includes('financialmodelingprep.com')).length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM price_candles WHERE ticker='O' AND source='MASSIVE'").get().n, 2);
    assert.equal(sqlite.prepare("SELECT close_price AS close FROM price_candles WHERE ticker='O' ORDER BY candle_date DESC LIMIT 1").get().close, 56);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('FMP 일봉이 정상이면 Massive를 호출하지 않고 FMP 출처로 저장한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('AAPL','Apple')");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    assert.match(String(input), /financialmodelingprep\.com\/stable\/historical-price-eod\/full/);
    return Response.json([{ date: '2026-09-22', open: 100, high: 102, low: 99, close: 101, volume: 500 }]);
  };
  try {
    const result = await syncTickerFromFmp({ DB, MARKET_DATA_API_KEY: 'test-fmp', MASSIVE_API_KEY: 'test-massive' },
      'AAPL', ['candles']);
    assert.equal(result.candles, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(sqlite.prepare("SELECT source FROM price_candles WHERE ticker='AAPL'").get().source, 'FMP');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('FMP 키가 없는 로컬 환경에서도 Massive 일봉을 저장한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('ABT','Abbott Laboratories')");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    assert.match(String(input), /api\.massive\.com\/v2\/aggs\/ticker\/ABT\/range\/1\/day/);
    assert.equal(options.headers.Authorization, 'Bearer test-massive');
    return Response.json({ status: 'OK', results: [
      { t: Date.parse('2026-09-22T04:00:00Z'), o: 101, h: 103, l: 100, c: 102, v: 2000 }
    ] });
  };
  try {
    const result = await syncTickerFromFmp({ DB, MASSIVE_API_KEY: 'test-massive' }, 'ABT', ['candles']);
    assert.equal(result.candles, 'ok');
    assert.equal(sqlite.prepare("SELECT source FROM price_candles WHERE ticker='ABT'").get().source, 'MASSIVE');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 배당의 페이지와 서로 다른 동시 지급 유형을 모두 저장한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('JPM','JPMorgan')");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes('cursor=second')) return Response.json({ status: 'OK', results: [
      { id: 'event-3', ex_dividend_date: '2026-06-01', pay_date: '2026-06-20',
        cash_amount: .5, distribution_type: 'recurring', frequency: 4 }
    ] });
    return Response.json({ status: 'OK', next_url: 'https://api.massive.com/stocks/v1/dividends?cursor=second', results: [
      { id: 'event-1', ex_dividend_date: '2026-09-01', pay_date: '2026-09-20',
        cash_amount: .5, distribution_type: 'recurring', frequency: 4 },
      { id: 'event-2', ex_dividend_date: '2026-09-01', pay_date: '2026-09-20',
        cash_amount: .5, distribution_type: 'special', frequency: 0 }
    ] });
  };
  try {
    const result = await syncTickerFromFmp({ DB, MASSIVE_API_KEY: 'test-massive' }, 'JPM', ['dividends']);
    assert.equal(result.dividends, 'ok');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 3);
    assert.equal(sqlite.prepare("SELECT distribution_type AS type FROM massive_dividend_events WHERE provider_event_id='event-2'").get().type, 'special');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 정상 빈 응답은 무배당 확인으로 저장한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('TSLA','Tesla');");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'OK', count: 0 });
  try {
    const result = await syncTickerFromFmp({ DB, MASSIVE_API_KEY: 'test-massive' }, 'TSLA', ['dividends']);
    assert.equal(result.dividends, 'ok');
    assert.equal(sqlite.prepare("SELECT last_success_at AS date FROM data_sync_state WHERE ticker='TSLA' AND data_type='dividends'").get().date !== null, true);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 지급액은 원본과 분할 조정액을 구분하고 특별배당도 실제 지급 수익률에 포함한다', () => {
  const result = combineDividendData(null, [
    { source: 'MASSIVE', exDividendDate: '2026-03-05', paymentDate: '2026-03-27', amount: .4,
      adjustedAmount: .04, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-06-05', paymentDate: '2026-06-27', amount: .05,
      adjustedAmount: .05, distributionType: 'recurring', frequency: 4 },
    { source: 'MASSIVE', exDividendDate: '2026-08-05', paymentDate: '2026-08-27', amount: .3,
      adjustedAmount: .3, distributionType: 'special', frequency: 0 }
  ], 10, '2026-09-23');
  assert.ok(Math.abs(result.dividendYield - 3.9) < 1e-9);
  assert.equal(result.lastPaidAmount, .3);
  assert.equal(result.specialPayoutCount, 1);
  assert.equal(result.frequency, 4);
});

test('배당락일이 지난 확정 지급일도 다음 지급일로 계속 표시한다', () => {
  const result = combineDividendData(null, [
    { source: 'MASSIVE', exDividendDate: '2026-09-15', paymentDate: '2026-10-01',
      declarationDate: '2026-08-25', amount: .5, distributionType: 'recurring', frequency: 4 }
  ], 100, '2026-09-23');
  assert.equal(result.nextExDividendDate, null);
  assert.equal(result.nextPaymentDate, '2026-10-01');
  assert.equal(result.nextPaymentDateStatus, 'confirmed');
  assert.equal(result.dividendYield, null);
});

test('오래된 FMP 현재가는 배당수익률 분모로 쓰지 않고 최근 저장 일봉 종가를 사용한다', async () => {
  const { DB, sqlite } = database();
  const today = new Date().toISOString().slice(0, 10);
  const paidDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')").run();
  sqlite.prepare("INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0)").run();
  sqlite.prepare("INSERT INTO price_quotes(ticker,current_price,market_updated_at) VALUES ('O',100,'2020-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO price_candles(ticker,candle_date,close_price,source) VALUES ('O',?,50,'MASSIVE')").run(today);
  sqlite.prepare(`INSERT INTO massive_dividend_events(ticker,provider_event_id,ex_dividend_date,payment_date,amount)
    VALUES ('O','paid',?,?,1)`).run(paidDate, paidDate);
  try {
    const response = await worker.fetch(new Request('https://example.test/api/dashboard', {
      headers: { 'X-App-Pin': 'test-pin' }
    }), { DB, APP_PIN: 'test-pin' });
    const summary = await response.json();
    assert.equal(summary.stocks[0].dividendMetrics.dividendYield, 2);
    assert.equal(summary.stocks[0].dividendMetrics.yieldPriceSource, '최근 저장 일봉 종가');
  } finally { sqlite.close(); }
});

test('ABT처럼 새 공시 원문이 늦어도 기존 SEC 재무 이력은 저장됨으로 표시하고 다음 확인을 남긴다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('ABT','Abbott','1800');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','ABT','dividend',0);`);
  const oldFact = record('2026-04-01', '2026-06-30', 100, { accn: 'previous-filing' });
  const facts = { 'us-gaap': {
    Revenues: { units: { USD: [oldFact] } },
    NetIncomeLoss: { units: { USD: [oldFact] } },
    CommonStockDividendsPerShareDeclared: { units: { 'USD/shares': [oldFact] } }
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('/submissions/')) return Response.json({ filings: { recent: {
      form: ['10-Q'], accessionNumber: ['new-filing'], reportDate: ['2026-06-30']
    } } });
    if (url.includes('/companyfacts/')) return Response.json({ facts });
    throw new Error('SEC 외부 요청 금지');
  };
  try {
    const result = await runFundamentalBatch({ DB });
    const financial = result.results.find(job => job.kind === 'financials');
    assert.equal(financial.status, 'ready');
    assert.equal(financial.details.latestFilingPending, true);
    assert.ok(financial.details.note.includes('다음날'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sec_filing_checks').get().n, 0);
    assert.ok(sqlite.prepare('SELECT next_run_at AS nextRunAt FROM fundamental_jobs WHERE ticker=? AND kind=?')
      .get('ABT', 'financials').nextRunAt);
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
