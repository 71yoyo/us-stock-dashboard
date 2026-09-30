import { syncTickerDataType, syncTickerFromFmp } from './fmp-sync.js';
import { syncGroupedCandlesFromMassive } from './massive-sync.js';
import { runFundamentalBatch, fundamentalStatus, fundamentalDetails, fundamentalQueueRuntimeStatus } from './fundamental-sync.js';
import { readWilliamsSignals } from './williams-store.js';
import { businessQuantDividendView } from './businessquant-view.js';
import { runDividendPipeline } from './businessquant-sync.js';
import { completedUsSessionDate, isUsSessionCompleteToday } from './us-market-session.js';
import { readAnalysisProfile } from './company-classification.js';

const tickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/**
 * Pages와 Worker가 다른 도메인으로 배포될 수 있어 CORS 헤더를 일관되게 붙인다.
 * 실제 Pages 주소를 ALLOWED_ORIGIN에 설정한 뒤에는 모든 출처 허용 대신 해당 주소만 허용한다.
 */
function createHeaders(environment) {
  return {
    'Access-Control-Allow-Origin': environment.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Pin',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
}

function jsonResponse(environment, status, body) {
  return new Response(JSON.stringify(body), { status, headers: createHeaders(environment) });
}

function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function isTickerValid(ticker) {
  return tickerPattern.test(ticker);
}

/**
 * 관심종목은 개인 설정이므로, Worker Secret에 저장한 PIN이 일치할 때만 읽고 쓸 수 있다.
 * 4자리 PIN은 편의용 잠금이므로 금융계좌 비밀번호처럼 민감한 값은 이 앱에 저장하지 않는다.
 */
function isPinAuthorized(request, environment) {
  const configuredPin = environment.APP_PIN;
  const submittedPin = request.headers.get('X-App-Pin') || '';
  return Boolean(configuredPin) && submittedPin === configuredPin;
}

function getWatchlistUserId() {
  // 현재는 개인 대시보드 한 명만 사용하므로 고정 ID를 쓴다. 다중 사용자 로그인 도입 시 사용자 ID로 교체한다.
  return 'primary';
}

function normalizeWatchlist(rawWatchlist) {
  if (!Array.isArray(rawWatchlist) || rawWatchlist.length > 200) {
    return null;
  }

  const usedTickers = new Set();
  const toOptionalText = value => typeof value === 'string' ? value.trim().slice(0, 160) : null;
  const toOptionalNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

  const entries = [];
  for (const [index, rawStock] of rawWatchlist.entries()) {
    const ticker = normalizeTicker(rawStock?.ticker);
    // 이전 화면이 저장한 전략 값이 없을 때는 주가 투자 기본값으로 읽어, 과거 목록을 잃지 않게 한다.
    const strategy = rawStock?.strategy === 'dividend' ? 'dividend' : 'price';
    if (!isTickerValid(ticker) || usedTickers.has(ticker)) {
      return null;
    }

    usedTickers.add(ticker);
    entries.push({
      ticker,
      strategy,
      displayOrder: index,
      name: toOptionalText(rawStock.name),
      sector: toOptionalText(rawStock.sector),
      price: toOptionalNumber(rawStock.price),
      change: toOptionalNumber(rawStock.change),
      changePct: toOptionalNumber(rawStock.changePct)
    });
  }
  return entries;
}

async function listWatchlist(environment) {
  const result = await environment.DB.prepare(`
    SELECT user_watchlist.ticker, user_watchlist.strategy, user_watchlist.display_name AS name,
      user_watchlist.sector, companies.exchange,
      -- 시세가 아직 없을 때 과거 브라우저의 예시값을 되살리지 않는다.
      -- D1에 실제로 저장된 현재가만 모든 기기의 공통 기준으로 반환한다.
      price_quotes.current_price AS price,
      price_quotes.change_amount AS change,
      price_quotes.market_updated_at AS quoteUpdatedAt,
      price_quotes.cached_at AS quoteCachedAt,
      -- 공급원이 등락률을 주지 않은 경우에도 현재가·전일 종가라는 D1 원본으로만 계산한다.
      COALESCE(
        price_quotes.change_percent,
        CASE
          WHEN price_quotes.current_price IS NOT NULL
            AND price_quotes.previous_close IS NOT NULL
            AND price_quotes.previous_close != 0
          THEN ((price_quotes.current_price - price_quotes.previous_close) / price_quotes.previous_close) * 100
        END
      ) AS changePct
    FROM user_watchlist
    LEFT JOIN companies ON companies.ticker = user_watchlist.ticker
    LEFT JOIN price_quotes ON price_quotes.ticker = user_watchlist.ticker
    WHERE user_watchlist.user_id = ?
    ORDER BY user_watchlist.display_order ASC
  `).bind(getWatchlistUserId()).all();
  return result.results;
}

/** FMP 현재가가 비어도 최근 일봉 종가로 배당수익률을 계산하되 출처를 명확히 남긴다. */
function dividendReferencePrice(quotePrice, latestCandle, quoteUpdatedAt = null) {
  const freshSince = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  if (quotePrice !== null && quotePrice !== undefined && Number(quotePrice) > 0
    && String(quoteUpdatedAt || '').slice(0, 10) >= freshSince) {
    return { price: Number(quotePrice), source: '저장 현재가' };
  }
  if (latestCandle?.candleDate >= freshSince && Number(latestCandle.close) > 0) {
    return { price: Number(latestCandle.close), source: '최근 저장 일봉 종가' };
  }
  return { price: null, source: null };
}

/**
 * 잠금 해제 직후 필요한 화면 요약만 한 번에 반환한다.
 * 재무 10년 원본은 상세 분석 탭을 열 때만 가져와, 초기 화면에서 종목 수만큼
 * HTTP 요청이 늘어나는 문제를 막는다.
 */
async function getDashboardSummary(environment) {
  const watchlist = await listWatchlist(environment);
  if (watchlist.length === 0) return { watchlist, stocks: [] };

  const tickers = watchlist.map(item => item.ticker);
  const placeholders = tickers.map(() => '?').join(', ');
  const queries = [environment.DB.prepare(`
      SELECT ticker, candle_date AS candleDate, open_price AS open, high_price AS high,
      low_price AS low, close_price AS close, adjusted_close AS adjustedClose, volume, source
      FROM price_candles
      WHERE ticker IN (${placeholders})
        AND candle_date >= date('now', '-120 days')
      ORDER BY ticker ASC, candle_date ASC
    `).bind(...tickers)];
  queries.push(environment.DB.prepare(`SELECT * FROM bq_dividend_summary
    WHERE ticker IN (${placeholders})`).bind(...tickers));
  const results = await environment.DB.batch(queries);
  const candleResult = results[0];
  const bqSummaryResult = results[1];

  const candlesByTicker = new Map();
  for (const candle of candleResult.results) {
    const candles = candlesByTicker.get(candle.ticker) || [];
    candles.push(candle);
    candlesByTicker.set(candle.ticker, candles);
  }
  const bqByTicker = new Map(bqSummaryResult.results.map(row => [row.ticker, row]));
  const signalsByTicker = await readWilliamsSignals(environment, tickers);

  return {
    watchlist,
    stocks: watchlist.map(stock => {
      const candles = candlesByTicker.get(stock.ticker) || [];
      const reference = dividendReferencePrice(stock.price, candles.at(-1),
        stock.quoteUpdatedAt || stock.quoteCachedAt);
      return {
      ticker: stock.ticker,
      name: stock.name,
      sector: stock.sector,
      exchange: stock.exchange,
      currentPrice: stock.price,
      changeAmount: stock.change,
      changePercent: stock.changePct,
      candles,
      technicalSignal: signalsByTicker.get(stock.ticker) || null,
      // 새 공급원 적재 전에는 구형 Alpha 요약을 대신 섞어 표시하지 않는다.
      dividendMetrics: businessQuantDividendView(bqByTicker.get(stock.ticker),
        reference.price, reference.source)
      };
    })
  };
}

async function replaceWatchlist(environment, entries) {
  const userId = getWatchlistUserId();
  const statements = [
    environment.DB.prepare('DELETE FROM user_watchlist WHERE user_id = ?').bind(userId),
    ...entries.map(entry => environment.DB.prepare(`
      INSERT INTO user_watchlist (
        user_id, ticker, strategy, display_order, display_name, sector,
        saved_price, saved_change, saved_change_percent, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      userId, entry.ticker, entry.strategy, entry.displayOrder, entry.name, entry.sector,
      entry.price, entry.change, entry.changePct
    ))
  ];
  await environment.DB.batch(statements);
}

async function listCompanies(environment) {
  const query = `
    SELECT
      companies.ticker, companies.name, companies.sector, companies.industry,
      companies.exchange, companies.currency, companies.updated_at AS profileUpdatedAt,
      price_quotes.current_price AS currentPrice,
      price_quotes.change_percent AS changePercent,
      price_quotes.market_updated_at AS quoteUpdatedAt
    FROM companies
    LEFT JOIN price_quotes ON price_quotes.ticker = companies.ticker
    ORDER BY companies.ticker
  `;
  const result = await environment.DB.prepare(query).all();
  return result.results;
}

async function getCompany(environment, ticker) {
  const company = await environment.DB.prepare(`
    SELECT
      companies.ticker, companies.name, companies.sector, companies.industry,
      companies.exchange, companies.currency, companies.updated_at AS profileUpdatedAt,
      price_quotes.current_price AS currentPrice,
      price_quotes.previous_close AS previousClose,
      price_quotes.change_amount AS changeAmount,
      price_quotes.change_percent AS changePercent,
      price_quotes.market_updated_at AS quoteUpdatedAt,
      price_quotes.cached_at AS quoteCachedAt
    FROM companies
    LEFT JOIN price_quotes ON price_quotes.ticker = companies.ticker
    WHERE companies.ticker = ?
  `).bind(ticker).first();

  if (!company) {
    return null;
  }

  const [financials, candles, bqSummary, massiveRegularFrequency,
    latestMassiveDividendType, upcomingMassiveDeclaration] = await environment.DB.batch([
    environment.DB.prepare(`
      SELECT period_type AS periodType, fiscal_period_end AS fiscalPeriodEnd, reported_date AS reportedDate,
        fiscal_year AS fiscalYear, fiscal_period AS fiscalPeriod, period_start AS periodStart,
        revenue, operating_income AS operatingIncome, net_income AS netIncome, eps,
        peg_ratio AS pegRatio, pe_ratio AS peRatio, ps_ratio AS psRatio, free_cash_flow AS freeCashFlow,
        roe, roic, gross_margin AS grossMargin, operating_margin AS operatingMargin, source, cached_at AS cachedAt
      FROM financial_metrics WHERE ticker = ? AND source = 'SEC EDGAR'
      ORDER BY fiscal_period_end DESC LIMIT 50
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT candle_date AS candleDate, open_price AS open, high_price AS high,
        low_price AS low, close_price AS close, adjusted_close AS adjustedClose, volume, source
      FROM price_candles WHERE ticker = ?
      ORDER BY candle_date DESC LIMIT 260
    `).bind(ticker),
    environment.DB.prepare(`SELECT * FROM bq_dividend_summary WHERE ticker=?`).bind(ticker),
    // 정기 배당 빈도만 Massive의 최근 정기 이벤트에서 읽는다. 특별·비정기 이벤트는 제외한다.
    environment.DB.prepare(`SELECT frequency, ex_dividend_date AS exDividendDate,
      source_updated_at AS storedAt FROM massive_dividend_events
      WHERE ticker=? AND distribution_type='recurring' AND frequency > 0
      ORDER BY ex_dividend_date DESC, source_updated_at DESC LIMIT 1`).bind(ticker),
    // 마지막 배당 종류는 정기 빈도와 별개로 실제 지급된 가장 최근 이벤트에서 읽는다.
    environment.DB.prepare(`SELECT distribution_type AS distributionType,
      ex_dividend_date AS exDividendDate, payment_date AS paymentDate,
      source_updated_at AS storedAt FROM massive_dividend_events
      WHERE ticker=? AND distribution_type IS NOT NULL
        AND payment_date IS NOT NULL AND payment_date <= date('now')
      ORDER BY payment_date DESC, ex_dividend_date DESC LIMIT 1`).bind(ticker),
    environment.DB.prepare(`SELECT declaration_date AS declarationDate,
      ex_dividend_date AS exDividendDate FROM massive_dividend_events
      WHERE ticker=? AND ex_dividend_date > date('now') AND declaration_date <= date('now')
        AND ex_dividend_date=(SELECT next_ex_date FROM bq_dividend_summary WHERE ticker=?)
      ORDER BY ex_dividend_date LIMIT 1`).bind(ticker, ticker)
  ]);

  const extra = await fundamentalDetails(environment, ticker);
  const analysisProfile = await readAnalysisProfile(environment, company);
  const storedSignals = await readWilliamsSignals(environment, [ticker]);
  const reference = dividendReferencePrice(company.currentPrice, candles.results[0],
    company.quoteUpdatedAt || company.quoteCachedAt);
  const bqView = businessQuantDividendView(bqSummary.results[0], reference.price, reference.source);
  if (bqView) bqView.nextDeclarationDate = upcomingMassiveDeclaration.results[0]?.declarationDate || null;
  return {
    ...company,
    ...extra,
    // 분류는 additive metadata이다. 이번 Phase에서 UI와 재무 계산은 이를 사용하지 않는다.
    analysisProfile,
    // 장기 이력·성장률은 BQ 요약, 종류·선언일은 Massive 저장값만 사용한다.
    dividends: [],
    dividendMetrics: bqView,
    regularDividendFrequency: massiveRegularFrequency.results[0]
      ? { frequency: Number(massiveRegularFrequency.results[0].frequency),
        exDividendDate: massiveRegularFrequency.results[0].exDividendDate,
        storedAt: massiveRegularFrequency.results[0].storedAt, source: 'MASSIVE' }
      : null,
    lastMassiveDividendType: latestMassiveDividendType.results[0]
      ? { distributionType: latestMassiveDividendType.results[0].distributionType,
        exDividendDate: latestMassiveDividendType.results[0].exDividendDate,
        paymentDate: latestMassiveDividendType.results[0].paymentDate,
        storedAt: latestMassiveDividendType.results[0].storedAt, source: 'MASSIVE' }
      : null,
    financials: financials.results,
    technicalSignal: storedSignals.get(ticker) || null,
    candles: candles.results.reverse()
  };
}

const syncIntervalsInMinutes = {
  price: 30,
  candles: 24 * 60
};

function isSyncDue(syncState, intervalMinutes) {
  if (syncState?.nextRetryAt && new Date(syncState.nextRetryAt).getTime() > Date.now()) return false;
  if (!syncState?.lastSuccessAt) return true;
  const elapsed = Date.now() - new Date(syncState.lastSuccessAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= intervalMinutes * 60_000;
}

/**
 * 관심종목 전체를 작은 작업 단위로 나눈 뒤, 가장 오래 기다린 작업 하나만 선택한다.
 * 이 방식은 첫 적재에도 Cron 한 번당 외부 API 호출 묶음이 하나를 넘지 않게 한다.
 */
async function findNextSyncJob(environment) {
  const [watchlistResult, statesResult] = await environment.DB.batch([
    environment.DB.prepare('SELECT ticker FROM user_watchlist WHERE user_id = ? ORDER BY display_order ASC')
      .bind(getWatchlistUserId()),
    environment.DB.prepare(`SELECT ticker, data_type AS dataType, last_success_at AS lastSuccessAt,
      last_attempt_at AS lastAttemptAt, next_retry_at AS nextRetryAt
      FROM data_sync_state WHERE data_type IN ('price', 'candles')`)
  ]);
  const stateByKey = new Map(statesResult.results.map(state => [`${state.ticker}:${state.dataType}`, state]));
  const jobs = [];
  for (const { ticker } of watchlistResult.results) {
    for (const [dataType, intervalMinutes] of Object.entries(syncIntervalsInMinutes)) {
      if (dataType === 'price' && !environment.MARKET_DATA_API_KEY) continue;
      const state = stateByKey.get(`${ticker}:${dataType}`);
      if (isSyncDue(state, intervalMinutes)) {
        // 신규 종목은 분석에 필요한 3개월 일봉을 먼저 채운다. 기존 현재가 표시 방식은 바꾸지 않는다.
        jobs.push({
          ticker,
          dataType,
          lastAttemptAt: state?.lastAttemptAt || '1970-01-01T00:00:00.000Z',
          priority: dataType === 'candles' ? 0 : dataType === 'price' ? 1 : 2
        });
      }
    }
  }
  jobs.sort((left, right) => left.lastAttemptAt.localeCompare(right.lastAttemptAt)
    || left.priority - right.priority);
  return jobs[0] || null;
}

/** 장중 수집을 당일 완료로 보지 않고, 미 동부 정규장 종료 후 빠진 일봉을 한 종목씩 확인한다. */
export async function findNextPostCloseCandleJob(environment, now = new Date()) {
  const sessionDate = completedUsSessionDate(now);
  if (!sessionDate) return null;
  const result = await environment.DB.prepare(`SELECT w.ticker,
    (SELECT MAX(candle_date) FROM price_candles WHERE ticker=w.ticker) AS latestCandleDate,
    s.last_attempt_at AS lastAttemptAt,
    s.next_retry_at AS nextRetryAt
    FROM user_watchlist w
    LEFT JOIN data_sync_state s ON s.ticker = w.ticker AND s.data_type = 'candles'
    WHERE w.user_id = ?
    ORDER BY COALESCE(s.last_attempt_at, '1970-01-01T00:00:00.000Z'), w.display_order`)
    .bind(getWatchlistUserId()).all();
  // 요청 성공 시각이 아니라 실제 일봉 날짜로 판단해야 이전 거래일을 재수집한 성공도 놓치지 않는다.
  return result.results.find(row => (!row.latestCandleDate || row.latestCandleDate < sessionDate)
    && (!row.nextRetryAt || new Date(row.nextRetryAt).getTime() <= now.getTime())) || null;
}

/** 무료 Massive 전체 시장 일봉은 날짜당 한 번만 받고, 누락 종목은 개별 요청으로 보완한다. */
export async function synchronizePostCloseCandles(environment, now = new Date()) {
  const marketDate = completedUsSessionDate(now);
  if (!marketDate) return;
  const eligible = await environment.DB.prepare(`SELECT w.ticker FROM user_watchlist w
    JOIN data_sync_state s ON s.ticker=w.ticker AND s.data_type='candles'
    JOIN massive_candle_backfills b ON b.ticker=w.ticker
    WHERE w.user_id=? AND s.last_success_at IS NOT NULL ORDER BY w.display_order`)
    .bind(getWatchlistUserId()).all();
  let groupedReady = eligible.results.length === 0;
  if (eligible.results.length && environment.MASSIVE_API_KEY) {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
    const claim = await environment.DB.prepare(`INSERT INTO massive_daily_market_sync
      (market_date, status, last_attempt_at, lease_until) VALUES (?, 'running', ?, ?)
      ON CONFLICT(market_date) DO UPDATE SET status='running', last_attempt_at=excluded.last_attempt_at,
        lease_until=excluded.lease_until
      WHERE massive_daily_market_sync.status!='success'
        AND (massive_daily_market_sync.lease_until IS NULL OR massive_daily_market_sync.lease_until<?)
      RETURNING market_date`).bind(marketDate, nowIso, leaseUntil, nowIso).first();
    if (claim) {
      try {
        const result = await syncGroupedCandlesFromMassive(environment, marketDate,
          eligible.results.map(row => row.ticker));
        await environment.DB.prepare(`UPDATE massive_daily_market_sync SET status='success',
          completed_at=?, lease_until=NULL, last_error=NULL WHERE market_date=?`)
          .bind(new Date().toISOString(), marketDate).run();
        await environment.DB.prepare(`INSERT INTO sync_runs (data_type, status, message, completed_at)
          VALUES ('grouped_candles', 'success', ?, CURRENT_TIMESTAMP)`)
          .bind(JSON.stringify({ marketDate, count: result.count, missing: result.missing })).run();
        groupedReady = true;
      } catch (error) {
        await environment.DB.prepare(`UPDATE massive_daily_market_sync SET status='retry',
          lease_until=?, last_error=? WHERE market_date=?`)
          .bind(new Date(Date.now() + 15 * 60_000).toISOString(), String(error).slice(0, 500), marketDate).run();
      }
    } else {
      const state = await environment.DB.prepare(`SELECT status FROM massive_daily_market_sync
        WHERE market_date=?`).bind(marketDate).first();
      groupedReady = state?.status === 'success';
    }
  }
  if (!groupedReady) return;
  const job = await findNextPostCloseCandleJob(environment, now);
  if (!job) return;
  const result = await syncTickerDataType(environment, job.ticker, 'candles', { minimumCandleDate: marketDate });
  await environment.DB.prepare(`INSERT INTO sync_runs (data_type, ticker, status, message, completed_at)
    VALUES ('post_close_candles', ?, ?, ?, CURRENT_TIMESTAMP)`)
    .bind(job.ticker, result.candles === 'ok' ? 'success' : 'partial', JSON.stringify(result)).run();
}

/**
 * Cron 한 번에는 한 종목의 한 데이터 종류만 갱신한다.
 * 장기 이력은 여러 번에 나누어 D1에 채우고, 이미 정상 저장된 값은 유지한다.
 */
async function synchronizeMarketData(environment) {
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (!['FMP', 'MASSIVE'].includes(provider) || (!environment.MARKET_DATA_API_KEY && !environment.MASSIVE_API_KEY)) {
    await environment.DB.prepare(`INSERT INTO sync_runs (data_type, status, message, completed_at)
      VALUES ('scheduled_market_sync', 'skipped', '금융 API 공급자 또는 Secret이 설정되지 않아 동기화를 건너뜀', CURRENT_TIMESTAMP)`).run();
    return;
  }

  const job = await findNextSyncJob(environment);
  if (!job) return;

  await environment.DB.prepare(`
    INSERT INTO sync_runs (data_type, status, message, completed_at)
    VALUES ('scheduled_market_sync', 'running', ?, NULL)
  `).bind(`${job.ticker} ${job.dataType} 데이터 동기화 시작`).run();

  const result = await syncTickerDataType(environment, job.ticker, job.dataType);
  await environment.DB.prepare(`INSERT INTO sync_runs (data_type, ticker, status, message, completed_at)
    VALUES ('scheduled_market_sync', ?, ?, ?, CURRENT_TIMESTAMP)`)
    .bind(job.ticker, Object.values(result).every(value => value === 'ok') ? 'success' : 'partial', JSON.stringify({ ...job, result })).run();
}

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: createHeaders(environment) });
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      return jsonResponse(environment, 200, {
        status: 'ok',
        buildVersion: '2026-09-29-businessquant-growth-1',
        database: 'connected',
        marketDataConfigured: String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase() === 'FMP'
          && Boolean(environment.MARKET_DATA_API_KEY),
        massiveConfigured: Boolean(environment.MASSIVE_API_KEY),
        businessQuantConfigured: Boolean(environment.BUSINESS_QUANT_API_KEY),
        dividendPipelineEnabled: environment.DIVIDEND_PIPELINE_ENABLED === 'true',
        // 운영 환경의 큐 중지 여부만 읽는다. 진단 요청으로 DB 쓰기나 수집을 시작하지 않는다.
        fundamentalQueue: fundamentalQueueRuntimeStatus(environment)
      });
    }

    if (url.pathname === '/api/auth/verify') {
      if (request.method !== 'POST') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      if (!environment.APP_PIN) {
        return jsonResponse(environment, 503, { error: 'Worker PIN이 아직 설정되지 않았습니다.' });
      }
      return isPinAuthorized(request, environment)
        ? jsonResponse(environment, 200, { authenticated: true })
        : jsonResponse(environment, 401, { error: 'PIN 번호가 올바르지 않습니다.' });
    }

    if (url.pathname === '/api/watchlist') {
      if (!isPinAuthorized(request, environment)) {
        return jsonResponse(environment, environment.APP_PIN ? 401 : 503, {
          error: environment.APP_PIN ? 'PIN 인증이 필요합니다.' : 'Worker PIN이 아직 설정되지 않았습니다.'
        });
      }

      if (request.method === 'GET') {
        return jsonResponse(environment, 200, { watchlist: await listWatchlist(environment) });
      }

      if (request.method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse(environment, 400, { error: '목록 데이터 형식이 올바르지 않습니다.' });
        }
        const entries = normalizeWatchlist(body?.watchlist);
        if (!entries) {
          return jsonResponse(environment, 400, { error: '관심종목 목록을 확인해 주세요.' });
        }
        await replaceWatchlist(environment, entries);
        return jsonResponse(environment, 200, { watchlist: entries });
      }

      return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
    }

    if (url.pathname === '/api/dashboard') {
      if (request.method !== 'GET') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      if (!isPinAuthorized(request, environment)) {
        return jsonResponse(environment, environment.APP_PIN ? 401 : 503, {
          error: environment.APP_PIN ? 'PIN 인증이 필요합니다.' : 'Worker PIN이 아직 설정되지 않았습니다.'
        });
      }
      return jsonResponse(environment, 200, await getDashboardSummary(environment));
    }

    if (url.pathname === '/api/fundamentals/status' || url.pathname === '/api/fundamentals/run') {
      if (!isPinAuthorized(request, environment)) return jsonResponse(environment, 401, { error: 'PIN 인증이 필요합니다.' });
      const isStatus = url.pathname.endsWith('/status');
      if (request.method !== (isStatus ? 'GET' : 'POST')) return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      try {
        return jsonResponse(environment, 200, isStatus
          ? await fundamentalStatus({ ...environment }) : await runFundamentalBatch(environment));
      } catch (error) {
        return jsonResponse(environment, 502, { error: `수집 상태를 확인하지 못했습니다: ${error.message}` });
      }
    }

    if (url.pathname === '/api/sync') {
      if (request.method !== 'POST') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      if (!isPinAuthorized(request, environment)) {
        return jsonResponse(environment, environment.APP_PIN ? 401 : 503, {
          error: environment.APP_PIN ? 'PIN 인증이 필요합니다.' : 'Worker PIN이 아직 설정되지 않았습니다.'
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(environment, 400, { error: '동기화할 티커를 입력해 주세요.' });
      }
      const ticker = normalizeTicker(body?.ticker);
      if (!isTickerValid(ticker)) {
        return jsonResponse(environment, 400, { error: '티커 형식이 올바르지 않습니다.' });
      }

      try {
        // 신규 종목은 회사 정보·현재가·3개월 일봉을 저장하고 배당은 별도 BQ 예약 큐에서 처리한다.
        // 회사 테이블이 없는 상태에서 시세를 먼저 쓰면 외래 키 오류가 나므로 같은 순서로 묶는다.
        const market = await syncTickerFromFmp(environment, ticker, ['profile', 'price', 'candles']);
        // SEC 재무는 전용 큐에서 처리한다. 수동 저장 버튼은 BQ 호출 예산을 사용하지 않는다.
        const fundamental = await runFundamentalBatch(environment, ticker);
        const result = { market, fundamental };
        const marketFailed = Object.values(market).some(value => value !== 'ok');
        const fundamentalFailed = fundamental.results.some(job => job.status === 'error');
        const status = marketFailed || fundamentalFailed ? 'partial' : 'success';
        await environment.DB.prepare(`INSERT INTO sync_runs (data_type, ticker, status, message, completed_at)
          VALUES ('manual_market_sync', ?, ?, ?, CURRENT_TIMESTAMP)`)
          .bind(ticker, status, JSON.stringify(result)).run();
        return jsonResponse(environment, 200, { ticker, status, result });
      } catch (error) {
        return jsonResponse(environment, 502, { error: `동기화에 실패했습니다: ${String(error.message || error)}` });
      }
    }

    if (url.pathname === '/api/companies') {
      if (request.method !== 'GET') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      return jsonResponse(environment, 200, { companies: await listCompanies(environment) });
    }

    const companyMatch = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (companyMatch) {
      if (request.method !== 'GET') {
        return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
      }
      const ticker = normalizeTicker(decodeURIComponent(companyMatch[1]));
      if (!isTickerValid(ticker)) {
        return jsonResponse(environment, 400, { error: '티커 형식이 올바르지 않습니다.' });
      }

      const company = await getCompany(environment, ticker);
      return company
        ? jsonResponse(environment, 200, { company })
        : jsonResponse(environment, 404, { error: '저장된 회사 정보가 없습니다. 다음 동기화 후 다시 시도해 주세요.' });
    }

    return jsonResponse(environment, 404, { error: '존재하지 않는 API 경로입니다.' });
  },

  async scheduled(controller, environment, executionContext) {
    const now = new Date(controller.scheduledTime || Date.now());
    if (controller.cron === '1-59/5 * * * *') {
      // 무료 플랜의 기존 Cron 5개 안에서 재무와 배당 작업을 각각 독립적으로 실행한다.
      executionContext.waitUntil(runFundamentalBatch(environment));
      executionContext.waitUntil(runDividendPipeline(environment));
      return;
    }
    const isPostCloseCandleSweep = ['*/5 21-23 * * 1-5', '*/5 0-6 * * 2-6'].includes(controller.cron)
      || (controller.cron === '*/5 13-20 * * 1-5' && isUsSessionCompleteToday(now));
    executionContext.waitUntil(isPostCloseCandleSweep
      ? synchronizePostCloseCandles(environment, now) : synchronizeMarketData(environment));
  }
};
