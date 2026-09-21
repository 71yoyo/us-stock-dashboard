import { getDatabase } from "../db/database.js";

const tickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * 사용자가 입력한 티커를 API와 DB에서 동일하게 취급하기 위해 형식을 한 곳에서 검증한다.
 */
function validateTicker(ticker) {
  if (!tickerPattern.test(ticker)) {
    return "티커는 영문 대문자, 숫자, 점(.), 하이픈(-)만 사용해 1~10자로 입력해 주세요.";
  }

  return null;
}

export function listCompanies() {
  const database = getDatabase();
  return database.prepare(`
    SELECT
      companies.ticker,
      companies.name,
      companies.sector,
      companies.industry,
      companies.exchange,
      companies.currency,
      companies.updated_at AS profileUpdatedAt,
      price_quotes.current_price AS currentPrice,
      price_quotes.change_percent AS changePercent,
      price_quotes.market_updated_at AS quoteUpdatedAt
    FROM companies
    LEFT JOIN price_quotes ON price_quotes.ticker = companies.ticker
    ORDER BY companies.ticker
  `).all();
}

export function getCompany(tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const tickerError = validateTicker(ticker);

  if (tickerError) {
    return { error: tickerError, statusCode: 400 };
  }

  const database = getDatabase();
  const company = database.prepare(`
    SELECT
      companies.ticker,
      companies.name,
      companies.sector,
      companies.industry,
      companies.exchange,
      companies.currency,
      companies.updated_at AS profileUpdatedAt,
      price_quotes.current_price AS currentPrice,
      price_quotes.previous_close AS previousClose,
      price_quotes.change_amount AS changeAmount,
      price_quotes.change_percent AS changePercent,
      price_quotes.market_updated_at AS quoteUpdatedAt,
      price_quotes.cached_at AS quoteCachedAt
    FROM companies
    LEFT JOIN price_quotes ON price_quotes.ticker = companies.ticker
    WHERE companies.ticker = ?
  `).get(ticker);

  if (!company) {
    return { error: "저장된 회사 정보가 없습니다. API 동기화 후 다시 시도해 주세요.", statusCode: 404 };
  }

  const dividends = database.prepare(`
    SELECT declaration_date, ex_dividend_date, record_date, payment_date, amount, frequency, is_confirmed
    FROM dividend_events
    WHERE ticker = ?
    ORDER BY COALESCE(ex_dividend_date, payment_date) DESC
    LIMIT 20
  `).all(ticker);

  const financials = database.prepare(`
    SELECT fiscal_period_end, revenue, operating_income, net_income, eps, free_cash_flow, total_debt, cash_and_equivalents, cached_at
    FROM financial_snapshots
    WHERE ticker = ?
    ORDER BY fiscal_period_end DESC
    LIMIT 12
  `).all(ticker);

  return { company: { ...company, dividends, financials } };
}

export function createCompany(payload) {
  const ticker = normalizeTicker(payload?.ticker);
  const name = String(payload?.name ?? "").trim();
  const tickerError = validateTicker(ticker);

  if (tickerError) {
    return { error: tickerError, statusCode: 400 };
  }

  if (!name || name.length > 120) {
    return { error: "회사명은 1~120자로 입력해 주세요.", statusCode: 400 };
  }

  const database = getDatabase();
  database.prepare(`
    INSERT INTO companies (ticker, name, sector, industry, exchange, currency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET
      name = excluded.name,
      sector = excluded.sector,
      industry = excluded.industry,
      exchange = excluded.exchange,
      currency = excluded.currency,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    ticker,
    name,
    String(payload.sector ?? "").trim() || null,
    String(payload.industry ?? "").trim() || null,
    String(payload.exchange ?? "").trim() || null,
    String(payload.currency ?? "USD").trim().toUpperCase() || "USD"
  );

  return getCompany(ticker);
}
