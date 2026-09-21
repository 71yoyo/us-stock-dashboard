const tickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/**
 * Pages와 Worker가 다른 도메인으로 배포될 수 있어 CORS 헤더를 일관되게 붙인다.
 * 실제 Pages 주소를 ALLOWED_ORIGIN에 설정한 뒤에는 모든 출처 허용 대신 해당 주소만 허용한다.
 */
function createHeaders(environment) {
  return {
    'Access-Control-Allow-Origin': environment.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  const [dividends, financials, candles] = await environment.DB.batch([
    environment.DB.prepare(`
      SELECT declaration_date AS declarationDate, ex_dividend_date AS exDividendDate,
        record_date AS recordDate, payment_date AS paymentDate, amount, frequency,
        is_confirmed AS isConfirmed
      FROM dividend_events WHERE ticker = ?
      ORDER BY COALESCE(ex_dividend_date, payment_date) DESC LIMIT 20
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT fiscal_period_end AS fiscalPeriodEnd, revenue, operating_income AS operatingIncome,
        net_income AS netIncome, eps, free_cash_flow AS freeCashFlow,
        total_debt AS totalDebt, cash_and_equivalents AS cashAndEquivalents, cached_at AS cachedAt
      FROM financial_snapshots WHERE ticker = ?
      ORDER BY fiscal_period_end DESC LIMIT 12
    `).bind(ticker),
    environment.DB.prepare(`
      SELECT candle_date AS candleDate, open_price AS open, high_price AS high,
        low_price AS low, close_price AS close, adjusted_close AS adjustedClose, volume
      FROM price_candles WHERE ticker = ?
      ORDER BY candle_date DESC LIMIT 260
    `).bind(ticker)
  ]);

  return {
    ...company,
    dividends: dividends.results,
    financials: financials.results,
    candles: candles.results.reverse()
  };
}

/**
 * 공급자를 정하기 전에는 임의의 시세를 만들지 않는다.
 * Cron은 실행 이력을 남겨 배포와 스케줄 연결 여부를 확인할 수 있게 하고, API 키가 설정된 뒤 실제 동기화 로직을 추가한다.
 */
async function synchronizeMarketData(environment) {
  const provider = environment.MARKET_DATA_PROVIDER;
  const apiKey = environment.MARKET_DATA_API_KEY;
  const message = provider && apiKey
    ? '금융 API 동기화 공급자 구현 대기'
    : '금융 API 공급자 또는 Secret이 설정되지 않아 동기화를 건너뜀';
  const status = provider && apiKey ? 'pending_implementation' : 'skipped';

  await environment.DB.prepare(`
    INSERT INTO sync_runs (data_type, status, message, completed_at)
    VALUES ('scheduled_market_sync', ?, ?, CURRENT_TIMESTAMP)
  `).bind(status, message).run();
}

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: createHeaders(environment) });
    }

    if (request.method !== 'GET') {
      return jsonResponse(environment, 405, { error: '지원하지 않는 요청 방식입니다.' });
    }

    if (url.pathname === '/api/health') {
      return jsonResponse(environment, 200, {
        status: 'ok',
        database: 'connected',
        marketDataConfigured: Boolean(environment.MARKET_DATA_PROVIDER && environment.MARKET_DATA_API_KEY)
      });
    }

    if (url.pathname === '/api/companies') {
      return jsonResponse(environment, 200, { companies: await listCompanies(environment) });
    }

    const companyMatch = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (companyMatch) {
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

  async scheduled(_controller, environment, executionContext) {
    executionContext.waitUntil(synchronizeMarketData(environment));
  }
};
