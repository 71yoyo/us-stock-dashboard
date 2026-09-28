import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { latestSecValues, selectSecFacts, syncTickerFromFmp } from '../worker/src/fmp-sync.js';
import { runFundamentalBatch, fundamentalStatus } from '../worker/src/fundamental-sync.js';
import { ensureFundamentalStore, reserveFundamentalCall } from '../worker/src/fundamental-store.js';
import worker, { findNextPostCloseCandleJob, synchronizePostCloseCandles } from '../worker/src/index.js';
import { syncCandlesFromMassive, syncGroupedCandlesFromMassive } from '../worker/src/massive-sync.js';
import { syncDividendsFromMassive } from '../worker/src/massive-sync.js';
import { normalizeAlphaDividendHistory, summarizeAlphaDividendHistory, syncAlphaDividends } from '../worker/src/alpha-dividends.js';
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

test('Massive 전환 마이그레이션은 FMP 일봉을 보관하고 활성 화면 데이터는 즉시 지우지 않는다', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync(new URL('../worker/migrations/', import.meta.url)).sort()) {
      if (name === '0009_massive_primary_candles.sql') break;
      sqlite.exec(readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
    }
    sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
      INSERT INTO price_candles(ticker,candle_date,open_price,high_price,low_price,close_price,volume,source)
        VALUES ('O','2026-09-25',55,56,54,55.5,1000,'FMP');
      INSERT INTO data_sync_state(ticker,data_type,last_success_at)
        VALUES ('O','candles','2026-09-25T22:00:00.000Z');`);
    sqlite.exec(readFileSync(new URL('../worker/migrations/0009_massive_primary_candles.sql', import.meta.url), 'utf8'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM archived_fmp_candles WHERE ticker='O'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT source FROM price_candles WHERE ticker='O'").get().source, 'FMP');
    assert.equal(sqlite.prepare("SELECT last_success_at AS at FROM data_sync_state WHERE ticker='O' AND data_type='candles'").get().at,
      null);
  } finally { sqlite.close(); }
});

test('5-3의 FMP 일봉은 Massive 전환 전까지 저장 완료 집계에 넣지 않는다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('NVDA','NVIDIA');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order)
      VALUES ('primary','NVDA','price',0);
    INSERT INTO price_candles(ticker,candle_date,close_price,source)
      VALUES ('NVDA','2026-09-25',200,'FMP');
    INSERT INTO data_sync_state(ticker,data_type,last_success_at)
      VALUES ('NVDA','candles','2026-09-25T22:00:00.000Z');`);
  try {
    const before = await fundamentalStatus({ DB });
    assert.equal(before.stocks[0].candles.status, 'partial');
    assert.equal(before.stocks[0].candles.conversionPending, true);
    assert.equal(before.stocks[0].candles.source, 'FMP');
    assert.equal(before.summary.candles.stored, 0);
    assert.equal(before.summary.candles.processed, 0);

    sqlite.exec(`UPDATE price_candles SET source='MASSIVE' WHERE ticker='NVDA';
      INSERT INTO massive_candle_backfills(ticker) VALUES ('NVDA');`);
    const after = await fundamentalStatus({ DB });
    assert.equal(after.stocks[0].candles.status, 'ready');
    assert.equal(after.stocks[0].candles.conversionPending, false);
    assert.equal(after.summary.candles.stored, 1);
    assert.equal(after.summary.candles.processed, 1);
    assert.equal(after.stocks[0].candles.latestDate, '2026-09-25');
  } finally { sqlite.close(); }
});

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
    { source: 'ALPHA_VANTAGE', exDividendDate: '2025-12-01', paymentDate: '2025-12-15', amount: .5 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-03-01', paymentDate: '2026-03-15', amount: .5 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-06-01', paymentDate: '2026-06-15', amount: .6 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-09-01', paymentDate: '2026-09-15', amount: .6 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-12-01', paymentDate: '2026-12-15', amount: .7 }
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
    return { source: 'ALPHA_VANTAGE', exDividendDate: isoDate,
      paymentDate: `${isoDate.slice(0, 8)}15`, amount: .1 };
  });
  const metrics = combineDividendData(null, events, 24, '2026-01-01');
  assert.ok(Math.abs(metrics.annualDividend - 1.2) < 1e-9);
  assert.ok(Math.abs(metrics.dividendYield - 5) < 1e-9);
  assert.equal(metrics.trailingPayoutCount, 12);
});

test('SEC 재무는 유지하고 배당은 Alpha Vantage 키가 없으면 기존 값을 건드리지 않는다', async () => {
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
    assert.ok(status.jobs.filter(job => job.kind === 'financials')
      .every(job => job.status === 'ready' && job.details.source === 'SEC EDGAR'));
    assert.ok(status.jobs.filter(job => job.kind === 'dividends').every(job => job.status === 'error'));
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').dividendEvents.status, 'error');
    // 5-3은 재무 작업과 별개로 D1에 저장된 최신 현재가도 같은 종목 행에서 보여 준다.
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').price.currentPrice, 100);
    assert.equal(status.stocks.find(stock => stock.ticker === 'O').price.status, 'ready');
    assert.ok(batches.flatMap(batch => batch.results).filter(row => row.kind === 'financials')
      .every(row => row.status !== 'error'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='dividend_periods'").get().n, 0);
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

test('Alpha Vantage 당시 배당금은 이후 주식분할을 조정하고 완료 연도의 1·5·10년 성장률만 계산한다', () => {
  const raw = { symbol: 'TEST', data: [
    ['2014-01-05', .1], ['2015-06-05', 1], ['2020-06-05', 1.5],
    ['2024-06-05', 1.8], ['2025-06-05', 2], ['2026-06-05', 99]
  ].map(([ex_dividend_date, amount]) => ({ ex_dividend_date, amount: String(amount) })) };
  const { events } = normalizeAlphaDividendHistory(raw,
    { data: [{ effective_date: '2022-01-01', split_factor: '2.0000' }] }, 'TEST');
  assert.equal(events.find(row => row.exDividendDate === '2015-06-05').adjustedAmount, .5);
  assert.equal(events.find(row => row.exDividendDate === '2025-06-05').adjustedAmount, 2);
  const metrics = summarizeAlphaDividendHistory(events, '2026-09-28');
  assert.equal(metrics.annualDividend, 2);
  assert.ok(Math.abs(metrics.dividendGrowth1y - (2 / 1.8 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(metrics.dividendGrowthCagr5y - (Math.pow(2 / .75, 1 / 5) - 1) * 100) < 1e-9);
  assert.ok(Math.abs(metrics.dividendGrowthCagr10y - (Math.pow(2 / .5, 1 / 10) - 1) * 100) < 1e-9);
  assert.equal(summarizeAlphaDividendHistory(events.filter(row => row.exDividendDate >= '2015-01-01'),
    '2026-09-28').dividendGrowthCagr10y, null);
});

test('Alpha Vantage 배당·분할 양쪽 응답이 성공해야만 새 원본으로 교체하고 Massive 보류 원본은 보존한다', async () => {
  const { DB, sqlite } = database();
  await ensureFundamentalStore({ DB });
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO massive_dividend_events(ticker,provider_event_id,ex_dividend_date,amount)
      VALUES ('O','old','2025-08-01',0.2);`);
  const originalFetch = globalThis.fetch;
  let failSplits = false;
  globalThis.fetch = async input => {
    const requestUrl = new URL(input);
    assert.equal(requestUrl.host, 'www.alphavantage.co');
    assert.equal(requestUrl.searchParams.get('apikey'), 'test-key');
    if (requestUrl.searchParams.get('function') === 'DIVIDENDS') return Response.json({ symbol: 'O', data: [
      { ex_dividend_date: '2025-08-01', payment_date: '2025-08-15', amount: '0.2' },
      { ex_dividend_date: '2026-08-01', payment_date: '2026-08-15', amount: '0.22' }
    ] });
    return failSplits ? Response.json({ Information: 'quota' }) : Response.json({ symbol: 'O', data: [] });
  };
  try {
    const environment = { DB, ALPHA_VANTAGE_API_KEY: 'test-key' };
    const result = await syncAlphaDividends(environment, 'O');
    assert.equal(result.eventCount, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM alpha_dividend_events').get().n, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='dividend_periods'").get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 1);
    failSplits = true;
    await assert.rejects(syncAlphaDividends(environment, 'O'), /호출 제한/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM alpha_dividend_events').get().n, 2);
    assert.equal(sqlite.prepare("SELECT status FROM alpha_dividend_sync WHERE ticker='O'").get().status, 'ready');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Alpha Vantage 저장 완료 종목만 종합·상세 화면에 배당을 표시한다', async () => {
  const { DB, sqlite } = database();
  await ensureFundamentalStore({ DB });
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO massive_dividend_events(ticker,provider_event_id,ex_dividend_date,amount)
      VALUES ('O','old','2025-08-01',9);
    INSERT INTO alpha_dividend_events(ticker,event_key,ex_dividend_date,payment_date,amount,split_adjusted_amount)
      VALUES ('O','new','2026-08-01','2026-08-15',0.2,0.2);`);
  sqlite.prepare(`INSERT INTO alpha_dividend_sync(ticker,status,event_count,metrics_json,last_success_at)
    VALUES ('O','ready',1,?,CURRENT_TIMESTAMP)`)
    .run(JSON.stringify({ source: 'ALPHA_VANTAGE', dividendGrowth1y: 3.5,
      dividendGrowthCagr5y: 2.4, dividendGrowthCagr10y: 1.8 }));
  const environment = { DB, APP_PIN: 'test-pin' };
  try {
    const dashboard = await (await worker.fetch(new Request('https://example.test/api/dashboard',
      { headers: { 'X-App-Pin': 'test-pin' } }), environment)).json();
    const company = (await (await worker.fetch(new Request('https://example.test/api/companies/O'),
      environment)).json()).company;
    assert.equal(dashboard.stocks[0].dividendMetrics.source, 'ALPHA_VANTAGE');
    assert.equal('secAnnualDividend' in dashboard.stocks[0].dividendMetrics, false);
    assert.equal(company.dividendMetrics.dividendGrowthCagr10y, 1.8);
    assert.equal(company.dividendMetrics.eventSource, 'ALPHA_VANTAGE');
    assert.equal(company.dividends.length, 1);
    assert.equal(company.dividends[0].amount, 0.2);
    const status = await fundamentalStatus(environment);
    assert.equal(status.summary.dividends.stored, 1);
    assert.equal(status.stocks[0].dividendEvents.source, 'ALPHA_VANTAGE');
    await assert.rejects(syncTickerFromFmp(environment, 'O', ['dividends']), /동기화 대상이 아닙니다/);
  } finally { sqlite.close(); }
});

test('SEC·Massive 배당은 Alpha 화면 계산에 섞이지 않는다', () => {
  const metrics = combineDividendData({ source: 'SEC EDGAR', dividendGrowth1y: 99 }, [
    { source: 'MASSIVE', exDividendDate: '2026-08-01', paymentDate: '2026-08-15', amount: 9 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-08-01', paymentDate: '2026-08-15', amount: .2 }
  ], 100, '2026-09-23');
  assert.equal(metrics.dividendYield, .2);
  assert.equal(metrics.dividendGrowth1y, null);
  assert.equal(metrics.eventCount, 1);
  assert.equal('secAnnualDividend' in metrics, false);
});
test('미래 공시가 없으면 월배당 전월 이력 또는 전년 이력만 예상으로 표시한다', () => {
  const monthly = combineDividendData(null, [
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-06-15', paymentDate: '2026-06-30', amount: .1, distributionType: 'recurring', frequency: 12 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-07-15', paymentDate: '2026-07-30', amount: .1, distributionType: 'recurring', frequency: 12 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-08-15', paymentDate: '2026-08-30', amount: .1, distributionType: 'recurring', frequency: 12 }
  ], 100, '2026-09-23');
  assert.equal(monthly.nextExDividendDate, '2026-10-15');
  assert.equal(monthly.nextDateStatus, 'estimated');
  const quarterly = combineDividendData(null, [
    { source: 'ALPHA_VANTAGE', exDividendDate: '2025-11-01', paymentDate: '2025-11-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-02-01', paymentDate: '2026-02-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-05-01', paymentDate: '2026-05-15', amount: .5, distributionType: 'recurring', frequency: 4 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-08-01', paymentDate: '2026-08-15', amount: .5, distributionType: 'recurring', frequency: 4 }
  ], 100, '2026-09-23');
  assert.equal(quarterly.nextExDividendDate, '2026-11-01');
  assert.equal(quarterly.nextDateStatus, 'estimated');
});

test('Alpha 이력이 없으면 Massive 보류 원본이 있어도 배당은 미확보이고 SEC 재무는 유지한다', async () => {
  const { DB, sqlite } = database();
  await ensureFundamentalStore({ DB });
  sqlite.exec(`INSERT INTO companies(ticker,name,cik) VALUES ('O','Realty Income','726728');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO massive_dividend_events(ticker,provider_event_id,ex_dividend_date,payment_date,amount,distribution_type,frequency)
      VALUES ('O','regular','2026-08-01','2026-08-15',9,'recurring',12),
             ('O','special','2026-09-01','2026-09-15',1,'special',4),
             ('O','future','2099-10-15','2099-11-01',1,'irregular',0);
    INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source)
      VALUES ('O','quarterly','2026-06-30',1547711000,'SEC EDGAR');`);
  const environment = { DB, APP_PIN: 'test-pin' };
  try {
    const dashboard = await (await worker.fetch(new Request('https://example.test/api/dashboard',
      { headers: { 'X-App-Pin': 'test-pin' } }), environment)).json();
    assert.equal(dashboard.stocks[0].dividendMetrics.annualDividend, null);
    assert.equal(dashboard.stocks[0].dividendMetrics.dividendYield, null);
    const { company } = await (await worker.fetch(new Request('https://example.test/api/companies/O'), environment)).json();
    assert.equal(company.dividends.length, 0);
    assert.equal(company.dividendMetrics.eventSource, null);
    assert.equal(company.regularDividendFrequency.frequency, 12);
    assert.equal(company.regularDividendFrequency.exDividendDate, '2026-08-01');
    assert.equal(company.regularDividendFrequency.source, 'MASSIVE');
    assert.equal(company.lastMassiveDividendType.distributionType, 'special');
    assert.equal(company.lastMassiveDividendType.exDividendDate, '2026-09-01');
    assert.equal(company.lastMassiveDividendType.source, 'MASSIVE');
    assert.equal(company.financials[0].source, 'SEC EDGAR');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 3);
  } finally { sqlite.close(); }
});

test('5-3 배당 저장됨은 Alpha 동기화 완료와 실제 이벤트 건수가 일치할 때만 표시한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income'),('ABT','Abbott');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order)
      VALUES ('primary','O','dividend',0),('primary','ABT','dividend',1);
    INSERT INTO alpha_dividend_events(ticker,event_key,ex_dividend_date,amount,split_adjusted_amount)
      VALUES ('O','one','2026-08-01',.2,.2),('ABT','one','2026-08-01',.5,.5);
    INSERT INTO alpha_dividend_sync(ticker,status,event_count,last_success_at)
      VALUES ('O','ready',1,'2026-09-28T00:00:00Z');
    INSERT INTO fundamental_jobs(ticker,kind,status,details,error)
      VALUES ('O','dividends','ready','{"source":"SEC EDGAR","annualCount":9}',NULL),
             ('ABT','dividends','error','{"source":"SEC EDGAR","annualCount":7}','SEC EDGAR HTTP 403');`);
  try {
    const status = await fundamentalStatus({ DB });
    assert.equal(status.summary.dividends.stored, 1);
    assert.equal(status.summary.dividends.processed, 1);
    const o = status.stocks.find(stock => stock.ticker === 'O');
    const abt = status.stocks.find(stock => stock.ticker === 'ABT');
    assert.equal(o.dividendEvents.status, 'ready');
    assert.equal(o.jobs.dividends.details.source, 'ALPHA_VANTAGE');
    assert.equal('annualCount' in o.jobs.dividends.details, false);
    assert.equal(abt.dividendEvents.status, 'partial');
    assert.equal(abt.jobs.dividends.error, null);
    assert.equal(abt.dividendEvents.count, 1);
  } finally { sqlite.close(); }
});

test('SEC 배당 삭제 마이그레이션은 재무와 Massive 보류 원본을 보존한다', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync(new URL('../worker/migrations/', import.meta.url)).sort()) {
      if (name === '0012_alpha_only_dividends.sql') break;
      sqlite.exec(readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
    }
    sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
      CREATE TABLE dividend_periods(ticker TEXT, period_type TEXT, period_end TEXT, amount REAL, source TEXT);
      INSERT INTO dividend_periods VALUES ('O','annual','2025-12-31',3.2,'SEC EDGAR');
      INSERT INTO dividend_metrics(ticker,annual_dividend) VALUES ('O',3.2);
      INSERT INTO dividend_events(ticker,ex_dividend_date,amount,source) VALUES ('O','2025-01-01',3.2,'SEC EDGAR');
      CREATE TABLE fundamental_jobs(ticker TEXT, kind TEXT, status TEXT, checked_at TEXT,
        next_run_at TEXT, lease_until TEXT, lease_token TEXT, details TEXT, error TEXT,
        PRIMARY KEY(ticker, kind));
      INSERT INTO fundamental_jobs(ticker,kind,status,details)
        VALUES ('O','dividends','ready','{"source":"SEC EDGAR"}');
      INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,revenue,source)
        VALUES ('O','annual','2025-12-31',100,'SEC EDGAR');
      INSERT INTO massive_dividend_events(ticker,provider_event_id,ex_dividend_date,amount)
        VALUES ('O','archived','2025-01-01',.2);`);
    sqlite.exec(readFileSync(new URL('../worker/migrations/0012_alpha_only_dividends.sql', import.meta.url), 'utf8'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('dividend_periods','dividend_metrics')").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM dividend_events WHERE source='SEC EDGAR'").get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM financial_metrics').get().n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 1);
    const oldJob = sqlite.prepare("SELECT status, details FROM fundamental_jobs WHERE ticker='O' AND kind='dividends'").get();
    assert.equal(oldJob.status, 'pending');
    assert.equal(oldJob.details, '{}');
    sqlite.exec(`UPDATE fundamental_jobs SET status='error', error='SEC EDGAR HTTP 403' WHERE ticker='O';
      INSERT INTO companies(ticker,name) VALUES ('ABT','Abbott');
      INSERT INTO alpha_dividend_events(ticker,event_key,ex_dividend_date,amount,split_adjusted_amount)
        VALUES ('ABT','one','2026-08-01',.5,.5);
      INSERT INTO alpha_dividend_sync(ticker,status,event_count,last_success_at)
        VALUES ('ABT','ready',1,'2026-09-28T00:00:00Z');
      INSERT INTO fundamental_jobs(ticker,kind,status,details,error)
        VALUES ('ABT','dividends','error','{"source":"SEC EDGAR"}','SEC EDGAR HTTP 403');`);
    sqlite.exec(readFileSync(new URL('../worker/migrations/0013_clear_legacy_sec_dividend_jobs.sql', import.meta.url), 'utf8'));
    const cleared = sqlite.prepare("SELECT status, details, error FROM fundamental_jobs WHERE ticker='O'").get();
    assert.equal(cleared.status, 'pending');
    assert.equal(cleared.error, null);
    assert.equal(cleared.details, '{}');
    const repaired = sqlite.prepare("SELECT status, details, error FROM fundamental_jobs WHERE ticker='ABT'").get();
    assert.equal(repaired.status, 'ready');
    assert.equal(JSON.parse(repaired.details).source, 'ALPHA_VANTAGE');
    assert.equal(repaired.error, null);
  } finally { sqlite.close(); }
});
test('Massive 일봉이 정상이면 FMP 402 가능 종목도 FMP를 호출하지 않는다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input); requests.push(url);
    if (url.includes('financialmodelingprep.com')) throw new Error('Massive 성공 뒤 FMP를 요청해서는 안 됩니다.');
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
    assert.equal(requests.filter(url => url.includes('financialmodelingprep.com')).length, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM price_candles WHERE ticker='O' AND source='MASSIVE'").get().n, 2);
    assert.equal(sqlite.prepare("SELECT close_price AS close FROM price_candles WHERE ticker='O' ORDER BY candle_date DESC LIMIT 1").get().close, 56);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 일봉이 실패하면 FMP로 보조 수집하고 호출 순서를 유지한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('AAPL','Apple')");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    if (String(input).includes('api.massive.com')) return new Response('unavailable', { status: 503 });
    assert.match(String(input), /financialmodelingprep\.com\/stable\/historical-price-eod\/full/);
    return Response.json([{ date: '2026-09-22', open: 100, high: 102, low: 99, close: 101, volume: 500 }]);
  };
  try {
    const result = await syncTickerFromFmp({ DB, MARKET_DATA_API_KEY: 'test-fmp', MASSIVE_API_KEY: 'test-massive' },
      'AAPL', ['candles']);
    assert.equal(result.candles, 'ok');
    assert.equal(requests.length, 2);
    assert.match(requests[0], /api\.massive\.com/);
    assert.match(requests[1], /financialmodelingprep\.com/);
    assert.equal(sqlite.prepare("SELECT source FROM price_candles WHERE ticker='AAPL'").get().source, 'FMP');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM archived_fmp_candles WHERE ticker='AAPL'").get().n, 1);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('FMP 보조 일봉은 같은 날짜의 Massive 저장값을 덮어쓰지 않는다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('AAPL','Apple');
    INSERT INTO price_candles(ticker,candle_date,open_price,high_price,low_price,close_price,volume,source)
    VALUES ('AAPL','2026-09-22',100,103,99,102,1000,'MASSIVE');`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes('api.massive.com')
    ? new Response('unavailable', { status: 503 })
    : Response.json([
      { date: '2026-09-22', open: 100, high: 102, low: 99, close: 101, volume: 500 },
      { date: '2026-09-23', open: 101, high: 104, low: 100, close: 103, volume: 600 }
    ]);
  try {
    const result = await syncTickerFromFmp({ DB, MARKET_DATA_API_KEY: 'test-fmp', MASSIVE_API_KEY: 'test-massive' },
      'AAPL', ['candles']);
    assert.equal(result.candles, 'ok');
    assert.deepEqual(sqlite.prepare(`SELECT candle_date AS date, close_price AS close, source
      FROM price_candles WHERE ticker='AAPL' ORDER BY candle_date`).all().map(row => ({ ...row })), [
      { date: '2026-09-22', close: 102, source: 'MASSIVE' },
      { date: '2026-09-23', close: 103, source: 'FMP' }
    ]);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 실패 후 FMP 402는 한 달 차단하고 기존 일봉을 유지한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO price_candles(ticker,candle_date,close_price,source) VALUES ('O','2026-09-22',55,'FMP');`);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Response('unavailable', { status: String(input).includes('massive.com') ? 503 : 402 });
  };
  try {
    const env = { DB, MARKET_DATA_API_KEY: 'test-fmp', MASSIVE_API_KEY: 'test-massive' };
    assert.notEqual((await syncTickerFromFmp(env, 'O', ['candles'])).candles, 'ok');
    assert.notEqual((await syncTickerFromFmp(env, 'O', ['candles'])).candles, 'ok');
    assert.equal(requests.filter(url => url.includes('financialmodelingprep.com')).length, 1);
    assert.equal(sqlite.prepare("SELECT close_price AS close FROM price_candles WHERE ticker='O'").get().close, 55);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 저장 오류는 FMP 호출로 덮지 않고 오류로 남긴다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json({ status: 'OK', results: [
      { t: Date.parse('2026-09-25T04:00:00Z'), o: 55, h: 56, l: 54, c: 55.5, v: 1000 }
    ] });
  };
  const failingDB = { ...DB, prepare(sql) {
    if (sql.includes('DELETE FROM price_candles')) throw new Error('D1 저장 실패');
    return DB.prepare(sql);
  } };
  try {
    const result = await syncTickerFromFmp({ DB: failingDB, MASSIVE_API_KEY: 'test-massive',
      MARKET_DATA_API_KEY: 'test-fmp' }, 'O', ['candles']);
    assert.match(result.candles, /D1 저장 실패/);
    assert.equal(requests.filter(url => url.includes('financialmodelingprep.com')).length, 0);
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

test('당일 Massive 일봉 공개 전에는 이전 일봉을 다시 쓰거나 FMP로 우회하지 않고 15분 뒤 재시도한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO price_candles(ticker,candle_date,open_price,high_price,low_price,close_price,volume,source,cached_at)
      VALUES ('O','2026-09-25',55,56,54,55,1000,'MASSIVE','2026-09-25 22:00:00');`);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json({ status: 'OK', adjusted: true, results: [
      { t: Date.parse('2026-09-25T04:00:00Z'), o: 55, h: 56, l: 54, c: 55.5, v: 1000 }
    ] });
  };
  try {
    const result = await syncTickerFromFmp({ DB, MASSIVE_API_KEY: 'test-massive', MARKET_DATA_API_KEY: 'test-fmp' },
      'O', ['candles'], { minimumCandleDate: '2026-09-28' });
    assert.match(result.candles, /공개 대기/);
    assert.equal(requests.length, 1);
    assert.equal(sqlite.prepare("SELECT cached_at AS at FROM price_candles WHERE ticker='O'").get().at,
      '2026-09-25 22:00:00');
    const state = sqlite.prepare("SELECT last_attempt_at AS attempt, next_retry_at AS retry FROM data_sync_state WHERE ticker='O'").get();
    assert.ok(Math.abs((Date.parse(state.retry) - Date.parse(state.attempt)) / 60_000 - 15) < 1);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 이력이 지나치게 짧으면 기존 FMP 3개월치를 보존한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')");
  const insert = sqlite.prepare(`INSERT INTO price_candles
    (ticker,candle_date,open_price,high_price,low_price,close_price,volume,source)
    VALUES ('O',?,55,56,54,55,1000,'FMP')`);
  for (let day = 1; day <= 30; day += 1) {
    insert.run(new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10));
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'OK', results: [
    { t: Date.now(), o: 55, h: 56, l: 54, c: 55.5, v: 1000 }
  ] });
  try {
    await assert.rejects(syncCandlesFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' }, 'O'), /짧아/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM price_candles WHERE ticker='O' AND source='FMP'").get().n, 30);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Massive 최신 날짜가 기존 FMP보다 늦으면 교체하지 않고 원본을 유지한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO price_candles(ticker,candle_date,close_price,source)
      VALUES ('O','2026-09-25',55,'FMP');`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'OK', adjusted: true, results: [
    { t: Date.parse('2026-09-24T04:00:00Z'), o: 54, h: 56, l: 53, c: 55, v: 1000 }
  ] });
  try {
    await assert.rejects(syncCandlesFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' }, 'O'), /오래되어/);
    assert.equal(sqlite.prepare("SELECT source FROM price_candles WHERE ticker='O' AND candle_date='2026-09-25'").get().source,
      'FMP');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('전체 시장 일봉 한 요청으로 100종목만 저장하고 미등록 종목은 버린다', async () => {
  const { DB, sqlite } = database();
  const tickers = Array.from({ length: 100 }, (_, index) => `T${String(index).padStart(3, '0')}`);
  const company = sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)');
  const state = sqlite.prepare(`INSERT INTO data_sync_state(ticker,data_type,last_success_at)
    VALUES (?,'candles','2026-09-24T23:00:00.000Z')`);
  for (const ticker of tickers) { company.run(ticker, ticker); state.run(ticker); }
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    const t = Date.parse('2026-09-25T04:00:00Z');
    const rows = tickers.map(T => ({ T, t, o: 100, h: 102, l: 99, c: 101, v: 1000 }));
    rows.push({ T: 'OTHER', t, o: 10, h: 11, l: 9, c: 10, v: 100 });
    return Response.json({ status: 'OK', results: rows });
  };
  try {
    const result = await syncGroupedCandlesFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' },
      '2026-09-25', tickers);
    assert.equal(result.count, 100);
    assert.equal(result.missing.length, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/v2\/aggs\/grouped\/locale\/us\/market\/stocks\/2026-09-25/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM price_candles WHERE source='MASSIVE'").get().n, 100);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM price_candles WHERE ticker='OTHER'").get().n, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('묶음 일봉에서 빠진 종목은 성공 시각을 갱신하지 않는다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income'),('ABT','Abbott');
    INSERT INTO data_sync_state(ticker,data_type,last_success_at) VALUES
      ('O','candles','2026-09-24T22:00:00.000Z'),
      ('ABT','candles','2026-09-24T22:00:00.000Z');`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'OK', adjusted: true, results: [
    { T: 'O', t: Date.parse('2026-09-25T04:00:00Z'), o: 55, h: 56, l: 54, c: 55.5, v: 1000 }
  ] });
  try {
    const result = await syncGroupedCandlesFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' },
      '2026-09-25', ['O', 'ABT']);
    assert.equal(result.count, 1);
    assert.deepEqual(result.missing, ['ABT']);
    assert.equal(sqlite.prepare("SELECT last_success_at AS at FROM data_sync_state WHERE ticker='ABT'").get().at,
      '2026-09-24T22:00:00.000Z');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('장 마감 묶음 수집은 같은 날짜를 재호출하지 않고 Williams 신호도 갱신한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO data_sync_state(ticker,data_type,last_success_at)
      VALUES ('O','candles','2026-09-24T22:00:00.000Z');
    INSERT INTO massive_candle_backfills(ticker) VALUES ('O');`);
  const insert = sqlite.prepare(`INSERT INTO price_candles
    (ticker,candle_date,open_price,high_price,low_price,close_price,volume,source)
    VALUES ('O',?,55,56,54,55,1000,'MASSIVE')`);
  for (let day = 1; day <= 29; day += 1) {
    insert.run(new Date(Date.parse('2026-09-25T00:00:00Z') - day * 86_400_000).toISOString().slice(0, 10));
  }
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ status: 'OK', adjusted: true, results: [
      { T: 'O', t: Date.parse('2026-09-25T04:00:00Z'), o: 55, h: 57, l: 54, c: 56, v: 1200 }
    ] });
  };
  try {
    const environment = { DB, MASSIVE_API_KEY: 'test-massive' };
    const now = new Date('2026-09-25T22:10:00.000Z');
    await synchronizePostCloseCandles(environment, now);
    await synchronizePostCloseCandles(environment, now);
    assert.equal(requests, 1);
    assert.equal(sqlite.prepare("SELECT status FROM massive_daily_market_sync WHERE market_date='2026-09-25'").get().status,
      'success');
    assert.equal(sqlite.prepare("SELECT last_candle_date AS date FROM williams_signals WHERE ticker='O'").get().date,
      '2026-09-25');
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
    const result = await syncDividendsFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' }, 'JPM');
    assert.equal(result.source, 'MASSIVE');
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
    const result = await syncDividendsFromMassive({ DB, MASSIVE_API_KEY: 'test-massive' }, 'TSLA');
    assert.equal(result.source, 'MASSIVE');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM massive_dividend_events').get().n, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Alpha 지급액은 원본과 분할 조정액을 구분하고 배당 종류는 추정하지 않는다', () => {
  const result = combineDividendData(null, [
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-03-05', paymentDate: '2026-03-27', amount: .4,
      adjustedAmount: .04, distributionType: 'recurring', frequency: 4 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-06-05', paymentDate: '2026-06-27', amount: .05,
      adjustedAmount: .05, distributionType: 'recurring', frequency: 4 },
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-08-05', paymentDate: '2026-08-27', amount: .3,
      adjustedAmount: .3, distributionType: 'special', frequency: 0 }
  ], 10, '2026-09-23');
  assert.ok(Math.abs(result.dividendYield - 3.9) < 1e-9);
  assert.equal(result.lastPaidAmount, .3);
  assert.equal(result.specialPayoutCount, null);
  assert.equal(result.frequency, 4);
});

test('배당락일이 지난 확정 지급일도 다음 지급일로 계속 표시한다', () => {
  const result = combineDividendData(null, [
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-09-15', paymentDate: '2026-10-01',
      declarationDate: '2026-08-25', amount: .5, distributionType: 'recurring', frequency: 4 }
  ], 100, '2026-09-23');
  assert.equal(result.nextExDividendDate, null);
  assert.equal(result.nextPaymentDate, '2026-10-01');
  assert.equal(result.nextPaymentDateStatus, 'confirmed');
  assert.equal(result.nextDeclarationDate, null);
  assert.equal(result.dividendYield, null);
});

test('새 미래 배당 일정의 선언일은 다음 선언일로 표시한다', () => {
  const result = combineDividendData(null, [
    { source: 'ALPHA_VANTAGE', exDividendDate: '2026-10-15', paymentDate: '2026-11-01',
      declarationDate: '2026-09-25', amount: .5 }
  ], 100, '2026-09-28');
  assert.equal(result.nextDeclarationDate, '2026-09-25');
  assert.equal(result.nextExDividendDate, '2026-10-15');
});

test('오래된 FMP 현재가는 배당수익률 분모로 쓰지 않고 최근 저장 일봉 종가를 사용한다', async () => {
  const { DB, sqlite } = database();
  const today = new Date().toISOString().slice(0, 10);
  const paidDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO companies(ticker,name) VALUES ('O','Realty Income')").run();
  sqlite.prepare("INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0)").run();
  sqlite.prepare("INSERT INTO price_quotes(ticker,current_price,market_updated_at) VALUES ('O',100,'2020-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO price_candles(ticker,candle_date,close_price,source) VALUES ('O',?,50,'MASSIVE')").run(today);
  sqlite.prepare(`INSERT INTO alpha_dividend_events(ticker,event_key,ex_dividend_date,payment_date,amount,split_adjusted_amount)
    VALUES ('O','paid',?,?,1,1)`).run(paidDate, paidDate);
  sqlite.prepare(`INSERT INTO alpha_dividend_sync(ticker,status,event_count,metrics_json,last_success_at)
    VALUES ('O','ready',1,'{}',CURRENT_TIMESTAMP)`).run();
  try {
    const response = await worker.fetch(new Request('https://example.test/api/dashboard', {
      headers: { 'X-App-Pin': 'test-pin' }
    }), { DB, APP_PIN: 'test-pin' });
    const summary = await response.json();
    assert.equal(summary.stocks[0].dividendMetrics.dividendYield, 2);
    assert.equal(summary.stocks[0].dividendMetrics.yieldPriceSource, '최근 저장 일봉 종가');
  } finally { sqlite.close(); }
});

test('장중 성공한 일봉은 장 마감 후 한 번 더 확인하고 같은 거래일 중복 호출은 피한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','O'),('ABT','ABT'),('NVDA','NVDA');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order)
    VALUES ('primary','O','dividend',0),('primary','ABT','dividend',1),('primary','NVDA','price',2);
    INSERT INTO data_sync_state(ticker,data_type,last_success_at,last_attempt_at,next_retry_at)
    VALUES ('O','candles','2026-09-25T15:58:00.000Z','2026-09-25T15:58:00.000Z',NULL),
      ('ABT','candles','2026-09-25T22:05:00.000Z','2026-09-25T22:05:00.000Z',NULL),
      ('NVDA','candles','2026-09-25T15:00:00.000Z','2026-09-25T15:00:00.000Z','2026-09-27T00:00:00.000Z');`);
  try {
    const fridayNight = new Date('2026-09-25T22:10:00.000Z');
    assert.equal((await findNextPostCloseCandleJob({ DB }, fridayNight))?.ticker, 'O');
    sqlite.exec(`INSERT INTO price_candles(ticker,candle_date,close_price,source)
      VALUES ('O','2026-09-25',55,'MASSIVE'),('ABT','2026-09-25',100,'MASSIVE');`);
    assert.equal(await findNextPostCloseCandleJob({ DB }, new Date('2026-09-26T00:30:00.000Z')), null);
  } finally { sqlite.close(); }
});

test('장 마감 후 Cron은 일반 시세 큐가 아닌 일봉 전용 큐로 연결한다', async () => {
  const { DB, sqlite } = database();
  let scheduledTask;
  try {
    worker.scheduled({ cron: '*/5 21-23 * * 1-5', scheduledTime: Date.parse('2026-09-25T22:10:00Z') }, { DB }, {
      waitUntil(promise) { scheduledTask = promise; }
    });
    assert.ok(scheduledTask);
    await scheduledTask;
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 0);
  } finally { sqlite.close(); }
});

test('서머타임 장 종료 뒤 기존 장중 Cron도 당일 Massive 일봉을 먼저 갱신한다', async () => {
  const { DB, sqlite } = database();
  sqlite.exec(`INSERT INTO companies(ticker,name) VALUES ('O','Realty Income');
    INSERT INTO user_watchlist(user_id,ticker,strategy,display_order) VALUES ('primary','O','dividend',0);
    INSERT INTO data_sync_state(ticker,data_type,last_success_at) VALUES ('O','candles','2026-09-25T22:00:00Z');
    INSERT INTO massive_candle_backfills(ticker) VALUES ('O');`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: 'OK', adjusted: true, results: [
    { T: 'O', t: Date.parse('2026-09-28T04:00:00Z'), o: 55, h: 56, l: 54, c: 55.5, v: 1000 }
  ] });
  try {
    let task;
    worker.scheduled({ cron: '*/5 13-20 * * 1-5', scheduledTime: Date.parse('2026-09-28T20:30:00Z') },
      { DB, MASSIVE_API_KEY: 'test-massive' }, { waitUntil(promise) { task = promise; } });
    await task;
    assert.equal(sqlite.prepare("SELECT status FROM massive_daily_market_sync WHERE market_date='2026-09-28'").get().status,
      'success');
    assert.equal(sqlite.prepare("SELECT MAX(candle_date) AS date FROM price_candles WHERE ticker='O'").get().date,
      '2026-09-28');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
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
