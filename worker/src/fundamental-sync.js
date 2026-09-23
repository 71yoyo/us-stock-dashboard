import { ensureFundamentalStore } from './fundamental-store.js';
import { syncProfile, syncFinancialsFromSec, syncDividendsFromSec } from './fmp-sync.js';

const kinds = ['profile', 'financials', 'dividends'];
const labels = { profile: '회사 정보', financials: '재무', dividends: '배당' };
const day = 86400000;
const after = milliseconds => new Date(Date.now() + milliseconds).toISOString();

/** 최초 1회 모든 목록을 등록하고, 신규 종목만 추가한다. 완료 작업은 다시 대기 상태로 만들지 않는다. */
async function seedJobs(environment) {
  await ensureFundamentalStore(environment);
  await environment.DB.batch(kinds.map(kind => environment.DB.prepare(`INSERT OR IGNORE INTO fundamental_jobs(ticker, kind)
    SELECT ticker, ? FROM user_watchlist WHERE user_id = 'primary'`).bind(kind)));
}

function readDetails(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

/**
 * 시세와 일봉은 fundamental_jobs가 아니라 data_sync_state에서 독립적으로 갱신한다.
 * 5-3 화면에서는 사용자가 한눈에 확인할 수 있도록 두 저장소의 상태를 같은 종목 행에 합친다.
 */
function marketStorageStatus(hasStoredValue, syncState) {
  if (hasStoredValue) return 'ready';
  if (syncState?.lastError) return 'error';
  if (syncState?.lastAttemptAt) return 'partial';
  return 'pending';
}

function nextMarketCheck(syncState, intervalMilliseconds) {
  if (syncState?.nextRetryAt) return syncState.nextRetryAt;
  if (!syncState?.lastSuccessAt) return null;
  const lastSuccess = new Date(syncState.lastSuccessAt).getTime();
  return Number.isFinite(lastSuccess) ? new Date(lastSuccess + intervalMilliseconds).toISOString() : null;
}

function earliestDate(...values) {
  const dates = values.filter(Boolean)
    .map(value => ({ value, time: new Date(value).getTime() }))
    .filter(item => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time);
  return dates[0]?.value || null;
}

export async function fundamentalStatus(environment) {
  await seedJobs(environment);
  const [jobResult, marketResult, financialCoverage, dividendCoverage] = await environment.DB.batch([
    environment.DB.prepare(`SELECT j.* FROM fundamental_jobs j
      JOIN user_watchlist w ON w.ticker = j.ticker AND w.user_id = 'primary'
      ORDER BY w.display_order, j.kind`),
    environment.DB.prepare(`SELECT
      w.ticker,
      w.display_order AS displayOrder,
      price_quotes.current_price AS currentPrice,
      price_quotes.change_percent AS changePercent,
      price_quotes.market_updated_at AS quoteUpdatedAt,
      price_quotes.cached_at AS quoteCachedAt,
      price_state.last_success_at AS priceLastSuccessAt,
      price_state.last_attempt_at AS priceLastAttemptAt,
      price_state.next_retry_at AS priceNextRetryAt,
      price_state.last_error AS priceLastError,
      candle_state.last_success_at AS candlesLastSuccessAt,
      candle_state.last_attempt_at AS candlesLastAttemptAt,
      candle_state.next_retry_at AS candlesNextRetryAt,
      candle_state.last_error AS candlesLastError,
      (SELECT COUNT(*) FROM price_candles candles WHERE candles.ticker = w.ticker) AS candleCount,
      (SELECT MAX(cached_at) FROM price_candles candles WHERE candles.ticker = w.ticker) AS candlesCachedAt,
      dividend_state.last_success_at AS eventsLastSuccessAt,
      dividend_state.last_attempt_at AS eventsLastAttemptAt,
      dividend_state.next_retry_at AS eventsNextRetryAt,
      dividend_state.last_error AS eventsLastError,
      (SELECT COUNT(*) FROM dividend_events events WHERE events.ticker = w.ticker AND events.source = 'FMP') AS eventCount
      FROM user_watchlist w
      LEFT JOIN price_quotes ON price_quotes.ticker = w.ticker
      LEFT JOIN data_sync_state price_state
        ON price_state.ticker = w.ticker AND price_state.data_type = 'price'
      LEFT JOIN data_sync_state candle_state
        ON candle_state.ticker = w.ticker AND candle_state.data_type = 'candles'
      LEFT JOIN data_sync_state dividend_state
        ON dividend_state.ticker = w.ticker AND dividend_state.data_type = 'dividends'
      WHERE w.user_id = 'primary'
      ORDER BY w.display_order`),
    environment.DB.prepare(`SELECT ticker,
      SUM(CASE WHEN period_type = 'annual' THEN 1 ELSE 0 END) AS annualCount,
      SUM(CASE WHEN period_type = 'quarterly' THEN 1 ELSE 0 END) AS quarterlyCount
      FROM financial_metrics WHERE source = 'SEC EDGAR' GROUP BY ticker`),
    environment.DB.prepare(`SELECT ticker,
      SUM(CASE WHEN period_type = 'annual' THEN 1 ELSE 0 END) AS annualCount,
      SUM(CASE WHEN period_type = 'quarterly' THEN 1 ELSE 0 END) AS quarterlyCount
      FROM dividend_periods WHERE source = 'SEC EDGAR' GROUP BY ticker`)
  ]);
  const financialByTicker = new Map(financialCoverage.results.map(row => [row.ticker, row]));
  const dividendByTicker = new Map(dividendCoverage.results.map(row => [row.ticker, row]));
  const rows = jobResult.results.map(job => {
    let status = job.status === 'running' && job.lease_until < new Date().toISOString() ? 'pending' : job.status;
    let details = readDetails(job.details);
    let error = job.error;
    const coverage = job.kind === 'financials' ? financialByTicker.get(job.ticker)
      : job.kind === 'dividends' ? dividendByTicker.get(job.ticker) : null;
    const hasSecHistory = coverage && (Number(coverage.annualCount) > 0 || Number(coverage.quarterlyCount) > 0);
    // 이전 버전의 '일부 저장'은 실제 SEC 행이 있으면 바로 정정한다. 신규 공시 반영 대기는 기존 저장값을 유지한다.
    const latestFilingPending = job.kind === 'financials' && /새 공시 원문 반영 대기/.test(error || '');
    if (hasSecHistory && (status === 'partial' || latestFilingPending)) {
      status = 'ready';
      details = { ...details, source: 'SEC EDGAR', annualCount: Number(coverage.annualCount),
        quarterlyCount: Number(coverage.quarterlyCount), latestFilingPending,
        note: latestFilingPending ? '기존 SEC 이력 저장됨 · 새 공시 원문은 다음날 재확인' : details.note };
      if (latestFilingPending) error = null;
    }
    return { ticker: job.ticker, kind: job.kind, label: labels[job.kind], status,
      checkedAt: job.checked_at, nextRunAt: job.next_run_at, details, error };
  });
  const jobsByTicker = new Map();
  rows.forEach(job => {
    const tickerJobs = jobsByTicker.get(job.ticker) || {};
    tickerJobs[job.kind] = job;
    jobsByTicker.set(job.ticker, tickerJobs);
  });
  const stocks = marketResult.results.map(stock => {
    const priceState = {
      lastSuccessAt: stock.priceLastSuccessAt, lastAttemptAt: stock.priceLastAttemptAt,
      nextRetryAt: stock.priceNextRetryAt, lastError: stock.priceLastError
    };
    const candlesState = {
      lastSuccessAt: stock.candlesLastSuccessAt, lastAttemptAt: stock.candlesLastAttemptAt,
      nextRetryAt: stock.candlesNextRetryAt, lastError: stock.candlesLastError
    };
    const hasQuote = stock.currentPrice !== null && Number.isFinite(Number(stock.currentPrice));
    const hasCandles = Number(stock.candleCount || 0) > 0;
    const price = {
      status: marketStorageStatus(hasQuote, priceState),
      currentPrice: hasQuote ? Number(stock.currentPrice) : null,
      changePercent: Number.isFinite(Number(stock.changePercent)) ? Number(stock.changePercent) : null,
      updatedAt: stock.quoteUpdatedAt || stock.quoteCachedAt || priceState.lastSuccessAt || null,
      nextRunAt: nextMarketCheck(priceState, 30 * 60_000),
      error: priceState.lastError || null
    };
    const candles = {
      status: marketStorageStatus(hasCandles, candlesState),
      count: Number(stock.candleCount || 0),
      updatedAt: stock.candlesCachedAt || candlesState.lastSuccessAt || null,
      nextRunAt: nextMarketCheck(candlesState, day),
      error: candlesState.lastError || null
    };
    const eventState = {
      lastSuccessAt: stock.eventsLastSuccessAt, lastAttemptAt: stock.eventsLastAttemptAt,
      nextRetryAt: stock.eventsNextRetryAt, lastError: stock.eventsLastError
    };
    const dividendEvents = {
      status: marketStorageStatus(Number(stock.eventCount || 0) > 0, eventState),
      count: Number(stock.eventCount || 0),
      nextRunAt: nextMarketCheck(eventState, day),
      error: eventState.lastError || null
    };
    const marketStatus = price.status === 'ready' && candles.status === 'ready'
      ? 'ready'
      : price.status === 'error' && candles.status === 'error'
        ? 'error'
        : price.status === 'pending' && candles.status === 'pending'
          ? 'pending'
          : 'partial';
    const jobs = jobsByTicker.get(stock.ticker) || {};
    return {
      ticker: stock.ticker,
      price,
      candles,
      dividendEvents,
      marketStatus,
      jobs,
      nextCheckAt: earliestDate(
        price.nextRunAt,
        candles.nextRunAt,
        dividendEvents.nextRunAt,
        ...Object.values(jobs).map(job => job.nextRunAt)
      )
    };
  });
  const summary = Object.fromEntries(kinds.map(kind => {
    const group = rows.filter(row => row.kind === kind);
    return [kind, { total: group.length,
      processed: group.filter(row => row.checkedAt).length,
      stored: group.filter(row => ['ready', 'partial'].includes(row.status)).length,
      pending: group.filter(row => ['pending', 'running'].includes(row.status)).length }];
  }));
  summary.price = {
    total: stocks.length,
    processed: stocks.filter(stock => stock.price.updatedAt).length,
    stored: stocks.filter(stock => stock.price.status === 'ready').length,
    pending: stocks.filter(stock => ['pending', 'partial'].includes(stock.price.status)).length
  };
  summary.candles = {
    total: stocks.length,
    processed: stocks.filter(stock => stock.candles.updatedAt).length,
    stored: stocks.filter(stock => stock.candles.status === 'ready').length,
    pending: stocks.filter(stock => ['pending', 'partial'].includes(stock.candles.status)).length
  };
  return { summary, jobs: rows, stocks, checkedAt: new Date().toISOString(), scope: [...kinds, 'price', 'candles'] };
}

async function latestFiling(environment, ticker) {
  const company = await environment.DB.prepare('SELECT cik FROM companies WHERE ticker = ?').bind(ticker).first();
  const cik = String(company?.cik || '').replace(/\D/g, '');
  if (!cik) throw new Error('회사 식별번호(CIK) 수집 대기');
  const response = await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, {
    headers: { 'User-Agent': environment.SEC_USER_AGENT || 'US Stock Pro https://github.com/71yoyo/us-stock-dashboard', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`SEC 공시 목록 HTTP ${response.status}`);
  const recent = (await response.json()).filings?.recent;
  const index = recent?.form?.findIndex(form => ['10-K', '10-Q', '10-K/A', '10-Q/A'].includes(form)) ?? -1;
  if (index < 0) throw new Error('지원되는 10-K·10-Q 공시가 없습니다. ETF·해외기업은 별도 공급자가 필요합니다.');
  return { accession: recent.accessionNumber[index], reportDate: recent.reportDate[index] };
}

async function financialTask(environment, ticker, previous) {
  const filing = await latestFiling(environment, ticker);
  const saved = await environment.DB.prepare('SELECT accession FROM sec_filing_checks WHERE ticker = ?').bind(ticker).first();
  if (saved?.accession === filing.accession && previous.annualCount) return previous;
  const details = await syncFinancialsFromSec(environment, ticker);
  // 공시 목록이 원문보다 먼저 갱신될 수 있다. 해당 accession이 없으면 다음날 다시 읽는다.
  const facts = environment.secFacts.get(ticker);
  const indexed = Object.values(facts?.['us-gaap'] || {}).some(fact =>
    Object.values(fact.units || {}).some(rows => rows.some(row => row.accn === filing.accession)));
  if (indexed) {
    await environment.DB.prepare(`INSERT INTO sec_filing_checks(ticker, accession, checked_at, report_date)
      VALUES (?, ?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET accession=excluded.accession,
      checked_at=excluded.checked_at, report_date=excluded.report_date`)
      .bind(ticker, filing.accession, new Date().toISOString(), filing.reportDate).run();
  }
  const coverage = await environment.DB.prepare(`SELECT MAX(fiscal_period_end) AS latestPeriod,
    SUM(CASE WHEN revenue IS NOT NULL AND net_income IS NOT NULL THEN 1 ELSE 0 END) AS coreRows
    FROM financial_metrics WHERE ticker = ? AND period_type = 'quarterly'`).bind(ticker).first();
  // 원문 반영이 하루 늦어도 이미 확보한 SEC 이력은 정상 저장으로 표시한다. accession은 갱신하지 않아 다음날 다시 확인한다.
  return { ...details, ...coverage, accession: indexed ? filing.accession : saved?.accession || null,
    latestFilingPending: !indexed,
    note: indexed ? 'SEC 제공 이력 저장. 원문에 없는 지표는 미확보로 표시합니다.'
      : 'SEC 제공 이력 저장. 새 공시 원문 반영 대기 중이며 다음날 다시 확인합니다.' };
}

async function dividendTask(environment, ticker) {
  // SEC는 연간·분기 주당배당금만 담당한다. FMP 이벤트 실패가 이 작업의 저장 상태를 바꾸지 않는다.
  const details = await syncDividendsFromSec(environment, ticker);
  return { ...details, note: 'SEC 주당배당금 이력 저장. 지급 이벤트·일정은 FMP에서 별도로 확인합니다.' };
}

export function classifyFundamental(kind, details) {
  if (kind === 'profile') return 'ready';
  // 저장 상태는 공급원이 제공한 이력의 확보 여부만 나타낸다. 개별 지표의 공란은 별도 안내한다.
  if (details?.source !== 'SEC EDGAR') return 'partial';
  return details.annualCount > 0 || details.quarterlyCount > 0 ? 'ready' : 'partial';
}

/** 요청/예약 실행이 겹쳐도 같은 작업은 2분 임대로 한 번만 수행한다. */
async function executeJob(environment, job) {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const claimed = await environment.DB.prepare(`UPDATE fundamental_jobs SET status='running', lease_token=?, lease_until=?
    WHERE ticker=? AND kind=? AND (lease_until IS NULL OR lease_until < ?)
      AND (next_run_at IS NULL OR next_run_at <= ?) RETURNING ticker`)
    .bind(token, after(120000), job.ticker, job.kind, now, now).first();
  if (!claimed) return { ticker: job.ticker, kind: job.kind, status: 'skipped' };
  let status, details = readDetails(job.details), error = null;
  let nextRun = after(job.kind === 'profile' ? 30 * day : day);
  try {
    if (job.kind === 'profile') {
      const existing = await environment.DB.prepare('SELECT cik, updated_at FROM companies WHERE ticker=?').bind(job.ticker).first();
      if (!existing?.cik || new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime() < Date.now() - 30 * day) {
        await syncProfile(environment, job.ticker);
      }
      details = { source: 'FMP' };
    } else if (job.kind === 'financials') {
      details = await financialTask(environment, job.ticker, details);
    } else details = await dividendTask(environment, job.ticker);
    status = classifyFundamental(job.kind, details);
  } catch (failure) {
    error = String(failure.message || failure).slice(0, 700);
    status = 'error';
    // 권한 제한/원문 미제공은 느리게, 일시적 네트워크 오류는 15분 뒤 재시도한다.
    nextRun = after(/402|429|예산|미확보|없습니다|다음날|지원되는/.test(error) ? day : /403/.test(error) ? day / 4 : 900000);
  }
  await environment.DB.prepare(`UPDATE fundamental_jobs SET status=?, details=?, error=?, checked_at=?,
    next_run_at=?, lease_until=NULL, lease_token=NULL WHERE ticker=? AND kind=? AND lease_token=?`)
    .bind(status, JSON.stringify(details), error, new Date().toISOString(), nextRun, job.ticker, job.kind, token).run();
  return { ticker: job.ticker, kind: job.kind, status, details, error };
}

export async function runFundamentalBatch(environment, requestedTicker = null) {
  const scope = { ...environment, secFacts: new Map() };
  await seedJobs(scope);
  const now = new Date().toISOString();
  const due = await scope.DB.prepare(`SELECT j.*, w.display_order FROM fundamental_jobs j
    JOIN user_watchlist w ON w.ticker=j.ticker AND w.user_id='primary'
    WHERE (j.next_run_at IS NULL OR j.next_run_at <= ?)
      AND (j.lease_until IS NULL OR j.lease_until < ?)
      AND (? IS NULL OR j.ticker=?)
    ORDER BY CASE WHEN j.checked_at IS NULL THEN 0 ELSE 1 END, j.checked_at, w.display_order`)
    .bind(now, now, requestedTicker, requestedTicker).all();
  const tickers = [...new Set(due.results.map(job => job.ticker))].slice(0, 2);
  const results = [];
  const started = Date.now();
  for (const ticker of tickers) {
    const token = crypto.randomUUID();
    const lock = await scope.DB.prepare(`INSERT INTO fundamental_locks(ticker, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
      WHERE expires_at < ? RETURNING ticker`).bind(ticker, token, after(120000), new Date().toISOString()).first();
    if (!lock) continue;
    try {
      for (const kind of kinds) {
        const job = due.results.find(item => item.ticker === ticker && item.kind === kind);
        if (!job || Date.now() - started > 20000) continue;
        results.push(await executeJob(scope, job));
      }
    } finally {
      scope.secFacts.delete(ticker);
      await scope.DB.prepare('DELETE FROM fundamental_locks WHERE ticker=? AND token=?').bind(ticker, token).run();
    }
  }
  return { results, status: await fundamentalStatus(scope) };
}

export async function fundamentalDetails(environment, ticker) {
  await ensureFundamentalStore(environment);
  const [jobs, history] = await environment.DB.batch([
    environment.DB.prepare('SELECT kind, status, details, error FROM fundamental_jobs WHERE ticker=?').bind(ticker),
    environment.DB.prepare(`SELECT period_type AS periodType, period_end AS periodEnd, amount, source
      FROM dividend_periods WHERE ticker=? ORDER BY period_end DESC`).bind(ticker)
  ]);
  return { collection: jobs.results.map(job => ({ ...job, details: readDetails(job.details) })), dividendHistory: history.results };
}

/** SEC의 기간별 주당배당금만 요약한다. 지급일별 이벤트나 배당수익률은 만들어 내지 않는다. */
export function summarizeSecDividendPeriods(history) {
  const periods = (Array.isArray(history) ? history : [])
    .filter(row => row.source === 'SEC EDGAR' && Number.isFinite(Number(row.amount)));
  const annual = periods.filter(row => row.periodType === 'annual')
    .sort((left, right) => String(left.periodEnd).localeCompare(String(right.periodEnd)));
  const quarterly = periods.filter(row => row.periodType === 'quarterly')
    .sort((left, right) => String(left.periodEnd).localeCompare(String(right.periodEnd)));
  if (!annual.length && !quarterly.length) return null;

  let dividendGrowthYears = 0;
  for (let index = annual.length - 1; index > 0; index -= 1) {
    const current = annual[index];
    const previous = annual[index - 1];
    if (Number(current.periodEnd.slice(0, 4)) - Number(previous.periodEnd.slice(0, 4)) !== 1
      || Number(current.amount) <= Number(previous.amount) + 1e-9) break;
    dividendGrowthYears += 1;
  }
  const latestAnnual = annual.at(-1);
  const startYear = Number(latestAnnual?.periodEnd.slice(0, 4)) - 10;
  const firstAnnual = annual.find(row => Number(row.periodEnd.slice(0, 4)) === startYear);
  const dividendGrowthCagr10y = Number(firstAnnual?.amount) > 0 && Number(latestAnnual?.amount) > 0
    ? (Math.pow(Number(latestAnnual.amount) / Number(firstAnnual.amount), 1 / 10) - 1) * 100 : null;
  return {
    annualDividend: latestAnnual ? Number(latestAnnual.amount) : null,
    quarterlyDividend: quarterly.length ? Number(quarterly.at(-1).amount) : null,
    dividendYield: null,
    dividendGrowthYears,
    dividendGrowthCagr10y,
    nextExDividendDate: null,
    nextDateStatus: 'unknown',
    nextPaymentDate: null,
    annualPeriodEnd: latestAnnual?.periodEnd || null,
    quarterlyPeriodEnd: quarterly.at(-1)?.periodEnd || null,
    source: 'SEC EDGAR'
  };
}

/** 계산식 변경 뒤에도 외부 호출 없이 저장된 SEC 이력에서 집계만 다시 만들 수 있다. */
export async function recalculateSecDividendMetrics(environment, ticker) {
  const { dividendHistory } = await fundamentalDetails(environment, ticker);
  const metrics = summarizeSecDividendPeriods(dividendHistory);
  if (!metrics) return { ticker, status: 'skipped', reason: '저장된 SEC 배당 이력 없음' };
  await environment.DB.prepare(`INSERT INTO dividend_metrics
    (ticker, annual_dividend, quarterly_dividend, dividend_yield, dividend_growth_years, dividend_growth_cagr_10y,
      next_ex_dividend_date, next_date_status, next_payment_date, calculated_at)
    VALUES (?, ?, ?, NULL, ?, ?, NULL, 'unknown', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET annual_dividend=excluded.annual_dividend,
      quarterly_dividend=excluded.quarterly_dividend, dividend_yield=NULL,
      dividend_growth_years=excluded.dividend_growth_years,
      dividend_growth_cagr_10y=excluded.dividend_growth_cagr_10y,
      next_ex_dividend_date=NULL, next_date_status='unknown', next_payment_date=NULL,
      calculated_at=CURRENT_TIMESTAMP`)
    .bind(ticker, metrics.annualDividend, metrics.quarterlyDividend,
      metrics.dividendGrowthYears, metrics.dividendGrowthCagr10y).run();
  return { ticker, status: 'updated', source: 'SEC EDGAR' };
}
