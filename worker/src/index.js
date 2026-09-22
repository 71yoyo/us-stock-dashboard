import { syncTickerDataType, syncTickerFromFmp } from './fmp-sync.js';
import { runFundamentalBatch, fundamentalStatus, fundamentalDetails } from './fundamental-sync.js';

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

  const [dividends, dividendMetrics, financials, candles] = await environment.DB.batch([
    environment.DB.prepare(`
      SELECT declaration_date AS declarationDate, ex_dividend_date AS exDividendDate,
        record_date AS recordDate, payment_date AS paymentDate, amount, frequency,
        is_confirmed AS isConfirmed
      FROM dividend_events WHERE ticker = ?
      ORDER BY COALESCE(ex_dividend_date, payment_date) DESC LIMIT 20
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT annual_dividend AS annualDividend, quarterly_dividend AS quarterlyDividend,
        dividend_yield AS dividendYield, dividend_growth_years AS dividendGrowthYears,
        dividend_growth_cagr_10y AS dividendGrowthCagr10y, next_ex_dividend_date AS nextExDividendDate,
        next_date_status AS nextDateStatus, next_payment_date AS nextPaymentDate, calculated_at AS calculatedAt
      FROM dividend_metrics WHERE ticker = ?
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT period_type AS periodType, fiscal_period_end AS fiscalPeriodEnd, reported_date AS reportedDate,
        revenue, operating_income AS operatingIncome, net_income AS netIncome, eps,
        peg_ratio AS pegRatio, pe_ratio AS peRatio, ps_ratio AS psRatio, free_cash_flow AS freeCashFlow,
        roe, roic, gross_margin AS grossMargin, operating_margin AS operatingMargin, source, cached_at AS cachedAt
      FROM financial_metrics WHERE ticker = ?
      ORDER BY fiscal_period_end DESC LIMIT 50
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT candle_date AS candleDate, open_price AS open, high_price AS high,
        low_price AS low, close_price AS close, adjusted_close AS adjustedClose, volume
      FROM price_candles WHERE ticker = ?
      ORDER BY candle_date DESC LIMIT 260
    `).bind(ticker)
  ]);

  const extra = await fundamentalDetails(environment, ticker);
  const dividendSource = extra.collection.find(job => job.kind === 'dividends')?.details?.source;
  return {
    ...company,
    ...extra,
    dividends: dividends.results,
    dividendMetrics: dividendMetrics.results[0]
      ? {
          ...dividendMetrics.results[0],
          // 이벤트가 있으면 FMP 원본, 집계만 있으면 SEC 공식 공시에서 계산한 값이다.
          source: dividendSource || (dividends.results.length ? 'FMP' : 'SEC EDGAR')
        }
      : null,
    financials: financials.results,
    candles: candles.results.reverse()
  };
}

const syncIntervalsInMinutes = {
  profile: 30 * 24 * 60,
  price: 30,
  candles: 24 * 60,
  dividends: 24 * 60,
  financials: 7 * 24 * 60
};

function isSyncDue(syncState, intervalMinutes) {
  if (syncState?.nextRetryAt && new Date(syncState.nextRetryAt).getTime() > Date.now()) return false;
  if (!syncState?.lastSuccessAt) return true;
  const elapsed = Date.now() - new Date(syncState.lastSuccessAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= intervalMinutes * 60_000;
}

function isFinancialRefreshDue(syncState, schedule, nyseHolidayDates) {
  if (syncState?.nextRetryAt && new Date(syncState.nextRetryAt).getTime() > Date.now()) return false;
  if (isSyncDue(syncState, syncIntervalsInMinutes.financials)) return true;
  if (!schedule?.nextEarningsDate) return false;

  // 발표일 다음 거래일부터 재무를 다시 읽는다. 주말과 D1에 저장된 NYSE 휴장일은 건너뛴다.
  const refreshDate = new Date(`${schedule.nextEarningsDate}T00:00:00Z`);
  refreshDate.setUTCDate(refreshDate.getUTCDate() + 1);
  while ([0, 6].includes(refreshDate.getUTCDay()) || nyseHolidayDates.has(refreshDate.toISOString().slice(0, 10))) {
    refreshDate.setUTCDate(refreshDate.getUTCDate() + 1);
  }
  const refreshDateText = refreshDate.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10) >= refreshDateText
    && String(syncState?.lastSuccessAt || '') < refreshDateText;
}

/**
 * 관심종목 전체를 작은 작업 단위로 나눈 뒤, 가장 오래 기다린 작업 하나만 선택한다.
 * 이 방식은 첫 적재에도 Cron 한 번당 외부 API 호출 묶음이 하나를 넘지 않게 한다.
 */
async function findNextSyncJob(environment) {
  const [watchlistResult, statesResult, schedulesResult, holidaysResult, coverageResult] = await environment.DB.batch([
    environment.DB.prepare('SELECT ticker FROM user_watchlist WHERE user_id = ? ORDER BY display_order ASC')
      .bind(getWatchlistUserId()),
    environment.DB.prepare(`SELECT ticker, data_type AS dataType, last_success_at AS lastSuccessAt,
      last_attempt_at AS lastAttemptAt, next_retry_at AS nextRetryAt
      FROM data_sync_state`),
    environment.DB.prepare(`SELECT ticker, next_earnings_date AS nextEarningsDate
      FROM earnings_schedule`),
    environment.DB.prepare(`SELECT holiday_date AS holidayDate FROM market_holidays
      WHERE market = 'NYSE' AND is_full_close = 1`),
    environment.DB.prepare(`SELECT user_watchlist.ticker,
      CASE WHEN EXISTS (
        SELECT 1 FROM financial_metrics
        WHERE financial_metrics.ticker = user_watchlist.ticker
          AND financial_metrics.period_type = 'quarterly'
          AND financial_metrics.fiscal_period_end >= date('now', '-18 months')
          AND financial_metrics.revenue IS NOT NULL
          AND financial_metrics.net_income IS NOT NULL
      ) THEN 1 ELSE 0 END AS hasUsableFinancials,
      CASE WHEN EXISTS (
        SELECT 1 FROM dividend_metrics
        WHERE dividend_metrics.ticker = user_watchlist.ticker
          AND dividend_metrics.annual_dividend IS NOT NULL
      ) THEN 1 ELSE 0 END AS hasDividendMetrics
      FROM user_watchlist WHERE user_watchlist.user_id = ?`).bind(getWatchlistUserId())
  ]);
  const stateByKey = new Map(statesResult.results.map(state => [`${state.ticker}:${state.dataType}`, state]));
  const scheduleByTicker = new Map(schedulesResult.results.map(schedule => [schedule.ticker, schedule]));
  const coverageByTicker = new Map(coverageResult.results.map(coverage => [coverage.ticker, coverage]));
  const nyseHolidayDates = new Set(holidaysResult.results.map(holiday => holiday.holidayDate));
  const jobs = [];
  for (const { ticker } of watchlistResult.results) {
    for (const [dataType, intervalMinutes] of Object.entries(syncIntervalsInMinutes)) {
      // 회사·재무·배당은 전용 큐로 옮긴다. 기존 시세/차트 수집 주기는 그대로 둔다.
      if (!['price', 'candles'].includes(dataType)) continue;
      const state = stateByKey.get(`${ticker}:${dataType}`);
      const coverage = coverageByTicker.get(ticker);
      const needsRepair = (dataType === 'financials' && Number(coverage?.hasUsableFinancials) !== 1)
        || (dataType === 'dividends' && Number(coverage?.hasDividendMetrics) !== 1);
      const retryAllowed = !state?.nextRetryAt || new Date(state.nextRetryAt).getTime() <= Date.now();
      const isNormallyDue = dataType === 'financials'
        ? isFinancialRefreshDue(state, scheduleByTicker.get(ticker), nyseHolidayDates)
        : isSyncDue(state, intervalMinutes);
      // 과거 코드가 빈 응답을 성공으로 기록했어도, 실제 핵심 값이 없으면 한 작업씩 자동 복구한다.
      const isDue = retryAllowed && (needsRepair || isNormallyDue);
      if (isDue) {
        // 최초 적재 때는 모든 종목의 현재가를 먼저 채워 목록이 비어 보이지 않게 한다.
        // 일봉은 그 다음 순서로 저장해 API 호출을 한 작업씩 유지한다.
        jobs.push({
          ticker,
          dataType,
          lastAttemptAt: state?.lastAttemptAt || '1970-01-01T00:00:00.000Z',
          priority: dataType === 'price' ? 0 : 1
        });
      }
    }
  }
  jobs.sort((left, right) => left.lastAttemptAt.localeCompare(right.lastAttemptAt)
    || left.priority - right.priority);
  return jobs[0] || null;
}

/**
 * Cron 한 번에는 한 종목의 한 데이터 종류만 갱신한다.
 * 장기 이력은 여러 번에 나누어 D1에 채우고, 이미 정상 저장된 값은 유지한다.
 */
async function synchronizeMarketData(environment) {
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (provider !== 'FMP' || !environment.MARKET_DATA_API_KEY) {
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
        buildVersion: '2026-09-22-tradingview-widget-1',
        database: 'connected',
        marketDataConfigured: String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase() === 'FMP'
          && Boolean(environment.MARKET_DATA_API_KEY)
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
        // 신규 종목은 먼저 회사 정보·현재가·3개월 일봉을 저장한다.
        // 회사 테이블이 없는 상태에서 시세를 먼저 쓰면 외래 키 오류가 나므로 같은 순서로 묶는다.
        const market = await syncTickerFromFmp(environment, ticker, ['profile', 'price', 'candles']);
        // 재무·배당은 장기 원본을 읽어야 하므로 전용 큐에서 제한된 속도로 이어서 처리한다.
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
    executionContext.waitUntil(controller.cron === '1-59/5 * * * *'
      ? runFundamentalBatch(environment) : synchronizeMarketData(environment));
  }
};
