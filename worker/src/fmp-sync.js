const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickNumber(record, keys) {
  for (const key of keys) {
    const value = toFiniteNumber(record?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function asRecords(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.historical) ? payload.historical : [];
}

function isoDateBefore(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function fetchFmp(environment, path, params = {}) {
  const url = new URL(`${FMP_BASE_URL}/${path}`);
  url.searchParams.set('apikey', environment.MARKET_DATA_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FMP 요청 실패: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.['Error Message'] || payload?.error) throw new Error(payload['Error Message'] || payload.error);
  return payload;
}

async function markSyncState(environment, ticker, dataType, error = null) {
  const now = new Date().toISOString();
  if (!error) {
    return environment.DB.prepare(`INSERT INTO data_sync_state (ticker, data_type, last_success_at, last_attempt_at, next_retry_at, failure_count, last_error)
      VALUES (?, ?, ?, ?, NULL, 0, NULL)
      ON CONFLICT(ticker, data_type) DO UPDATE SET last_success_at=excluded.last_success_at, last_attempt_at=excluded.last_attempt_at, next_retry_at=NULL, failure_count=0, last_error=NULL`
    ).bind(ticker, dataType, now, now).run();
  }
  // 실패 횟수에 따라 최대 24시간까지 재시도 간격을 늘려 무료 API 제한을 존중한다.
  return environment.DB.prepare(`INSERT INTO data_sync_state (ticker, data_type, last_attempt_at, next_retry_at, failure_count, last_error)
    VALUES (?, ?, ?, datetime(?, '+15 minutes'), 1, ?)
    ON CONFLICT(ticker, data_type) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      failure_count=data_sync_state.failure_count + 1,
      next_retry_at=datetime('now', '+' || MIN(1440, 15 * (1 << MIN(6, data_sync_state.failure_count))) || ' minutes'),
      last_error=excluded.last_error`
  ).bind(ticker, dataType, now, now, String(error).slice(0, 500)).run();
}

async function syncProfile(environment, ticker) {
  const [profile] = asRecords(await fetchFmp(environment, 'profile', { symbol: ticker }));
  if (!profile) throw new Error('FMP 회사 프로필이 없습니다.');
  await environment.DB.prepare(`INSERT INTO companies (ticker, name, sector, industry, exchange, currency, cik, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, sector=excluded.sector, industry=excluded.industry,
      exchange=excluded.exchange, currency=excluded.currency, cik=COALESCE(excluded.cik, companies.cik), updated_at=CURRENT_TIMESTAMP`
  ).bind(ticker, profile.companyName || profile.name || ticker, profile.sector, profile.industry, profile.exchangeShortName || profile.exchange,
    profile.currency || 'USD', profile.cik || null).run();
}

async function syncQuote(environment, ticker) {
  const [quote] = asRecords(await fetchFmp(environment, 'quote', { symbol: ticker }));
  if (quote) await environment.DB.prepare(`INSERT INTO price_quotes (ticker, current_price, previous_close, change_amount, change_percent, market_updated_at, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET current_price=excluded.current_price, previous_close=excluded.previous_close,
      change_amount=excluded.change_amount, change_percent=excluded.change_percent, market_updated_at=excluded.market_updated_at, cached_at=CURRENT_TIMESTAMP`
  ).bind(ticker, pickNumber(quote, ['price']), pickNumber(quote, ['previousClose']), pickNumber(quote, ['change']), pickNumber(quote, ['changesPercentage']), quote.timestamp ? new Date(quote.timestamp * 1000).toISOString() : null).run();
}

async function syncCandles(environment, ticker) {
  const records = asRecords(await fetchFmp(environment, 'historical-price-eod/full', { symbol: ticker, from: isoDateBefore(100) }));
  const statements = records.filter(row => row.date).map(row => environment.DB.prepare(`INSERT INTO price_candles
    (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker, candle_date) DO UPDATE SET open_price=excluded.open_price, high_price=excluded.high_price,
      low_price=excluded.low_price, close_price=excluded.close_price, adjusted_close=excluded.adjusted_close, volume=excluded.volume, cached_at=CURRENT_TIMESTAMP`
  ).bind(ticker, row.date, toFiniteNumber(row.open), toFiniteNumber(row.high), toFiniteNumber(row.low), toFiniteNumber(row.close), pickNumber(row, ['adjClose', 'adjustedClose']), toFiniteNumber(row.volume)));
  if (statements.length) await environment.DB.batch(statements);
}

function mapFinancial(income, cashflow, ratios, metrics, periodType) {
  return {
    periodType, fiscalPeriodEnd: income.date, reportedDate: income.acceptedDate?.slice(0, 10) || income.fillingDate || null,
    currency: income.reportedCurrency || 'USD', revenue: pickNumber(income, ['revenue']), operatingIncome: pickNumber(income, ['operatingIncome']),
    netIncome: pickNumber(income, ['netIncome']), eps: pickNumber(income, ['eps', 'epsdiluted']), freeCashFlow: pickNumber(cashflow, ['freeCashFlow']),
    pegRatio: pickNumber(ratios, ['priceEarningsToGrowthRatio', 'pegRatio']), peRatio: pickNumber(ratios, ['priceToEarningsRatio', 'priceEarningsRatio', 'peRatio']),
    psRatio: pickNumber(ratios, ['priceToSalesRatio', 'priceSalesRatio']), roe: pickNumber(ratios, ['returnOnEquity']), roic: pickNumber(ratios, ['returnOnInvestedCapital', 'roic']),
    grossMargin: pickNumber(income, ['grossProfitRatio']), operatingMargin: pickNumber(income, ['operatingIncomeRatio'])
  };
}

function toIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function addMonths(isoDate, months) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function calculateDividendMetrics(events, currentPrice) {
  const datedEvents = events.filter(event => event.exDividendDate && event.amount !== null);
  const annualAmounts = new Map();
  for (const event of datedEvents) {
    const year = event.exDividendDate.slice(0, 4);
    annualAmounts.set(year, (annualAmounts.get(year) || 0) + event.amount);
  }
  const years = [...annualAmounts.keys()].sort();
  const latestYear = years.at(-1);
  const annualDividend = latestYear ? annualAmounts.get(latestYear) : null;
  const recentEvents = [...datedEvents].sort((a, b) => b.exDividendDate.localeCompare(a.exDividendDate)).slice(0, 4);
  const quarterlyDividend = recentEvents.length ? recentEvents.reduce((total, event) => total + event.amount, 0) : null;

  let growthYears = 0;
  for (let index = years.length - 1; index > 0; index -= 1) {
    if (annualAmounts.get(years[index]) >= annualAmounts.get(years[index - 1])) growthYears += 1;
    else break;
  }
  const tenYearStart = years.length > 1 ? annualAmounts.get(years[0]) : null;
  const yearSpan = years.length - 1;
  const growthCagr = tenYearStart && annualDividend && yearSpan > 0
    ? (Math.pow(annualDividend / tenYearStart, 1 / yearSpan) - 1) * 100
    : null;
  const futureEvent = datedEvents.find(event => event.exDividendDate >= new Date().toISOString().slice(0, 10));
  const lastEvent = datedEvents.sort((a, b) => b.exDividendDate.localeCompare(a.exDividendDate))[0];
  const estimatedNextDate = !futureEvent && lastEvent ? addMonths(lastEvent.exDividendDate, 3) : null;
  const nextExDate = futureEvent?.exDividendDate || estimatedNextDate;
  const nextPaymentDate = futureEvent?.paymentDate || null;

  return {
    annualDividend,
    quarterlyDividend,
    dividendYield: annualDividend && currentPrice ? (annualDividend / currentPrice) * 100 : null,
    growthYears,
    growthCagr,
    nextExDate,
    nextPaymentDate,
    status: futureEvent ? 'confirmed' : estimatedNextDate ? 'estimated' : 'unknown'
  };
}

async function syncDividends(environment, ticker) {
  const records = asRecords(await fetchFmp(environment, 'dividends', { symbol: ticker }));
  const events = records.map(record => ({
    declarationDate: toIsoDate(record.declarationDate),
    exDividendDate: toIsoDate(record.date || record.exDividendDate),
    recordDate: toIsoDate(record.recordDate),
    paymentDate: toIsoDate(record.paymentDate),
    amount: pickNumber(record, ['dividend', 'adjDividend', 'amount']),
    frequency: typeof record.frequency === 'string' ? record.frequency : null
  })).filter(event => event.exDividendDate && event.amount !== null);

  const statements = events.map(event => environment.DB.prepare(`INSERT INTO dividend_events
    (ticker, declaration_date, ex_dividend_date, record_date, payment_date, amount, frequency, is_confirmed, source_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker, ex_dividend_date, payment_date, amount) DO UPDATE SET declaration_date=excluded.declaration_date,
      record_date=excluded.record_date, frequency=excluded.frequency, is_confirmed=1, source_updated_at=CURRENT_TIMESTAMP`
  ).bind(ticker, event.declarationDate, event.exDividendDate, event.recordDate, event.paymentDate, event.amount, event.frequency));
  if (statements.length) await environment.DB.batch(statements);

  const quote = await environment.DB.prepare('SELECT current_price AS currentPrice FROM price_quotes WHERE ticker = ?').bind(ticker).first();
  const calculated = calculateDividendMetrics(events, quote?.currentPrice);
  await environment.DB.prepare(`INSERT INTO dividend_metrics
    (ticker, annual_dividend, quarterly_dividend, dividend_yield, dividend_growth_years, dividend_growth_cagr_10y,
      next_ex_dividend_date, next_date_status, next_payment_date, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET annual_dividend=excluded.annual_dividend, quarterly_dividend=excluded.quarterly_dividend,
      dividend_yield=excluded.dividend_yield, dividend_growth_years=excluded.dividend_growth_years,
      dividend_growth_cagr_10y=excluded.dividend_growth_cagr_10y, next_ex_dividend_date=excluded.next_ex_dividend_date,
      next_date_status=excluded.next_date_status, next_payment_date=excluded.next_payment_date, calculated_at=CURRENT_TIMESTAMP`
  ).bind(ticker, calculated.annualDividend, calculated.quarterlyDividend, calculated.dividendYield, calculated.growthYears,
    calculated.growthCagr, calculated.nextExDate, calculated.status, calculated.nextPaymentDate).run();
}

async function syncFinancials(environment, ticker, periodType, limit) {
  const period = periodType === 'annual' ? 'annual' : 'quarter';
  const params = { symbol: ticker, period, limit };
  const [income, cashflow, ratios, metrics] = await Promise.all(['income-statement', 'cash-flow-statement', 'ratios', 'key-metrics'].map(path => fetchFmp(environment, path, params).then(asRecords)));
  const cashByDate = new Map(cashflow.map(row => [row.date, row]));
  const ratiosByDate = new Map(ratios.map(row => [row.date, row]));
  const metricsByDate = new Map(metrics.map(row => [row.date, row]));
  const statements = income.filter(row => row.date).map(row => {
    const item = mapFinancial(row, cashByDate.get(row.date), ratiosByDate.get(row.date), metricsByDate.get(row.date), periodType);
    return environment.DB.prepare(`INSERT INTO financial_metrics (ticker, period_type, fiscal_period_end, reported_date, currency, revenue, operating_income, net_income, eps, peg_ratio, pe_ratio, ps_ratio, free_cash_flow, roe, roic, gross_margin, operating_margin, source, source_updated_at, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FMP', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ticker, period_type, fiscal_period_end) DO UPDATE SET reported_date=excluded.reported_date, currency=excluded.currency, revenue=excluded.revenue, operating_income=excluded.operating_income, net_income=excluded.net_income, eps=excluded.eps, peg_ratio=excluded.peg_ratio, pe_ratio=excluded.pe_ratio, ps_ratio=excluded.ps_ratio, free_cash_flow=excluded.free_cash_flow, roe=excluded.roe, roic=excluded.roic, gross_margin=excluded.gross_margin, operating_margin=excluded.operating_margin, source_updated_at=excluded.source_updated_at, cached_at=CURRENT_TIMESTAMP`
    ).bind(ticker, item.periodType, item.fiscalPeriodEnd, item.reportedDate, item.currency, item.revenue, item.operatingIncome, item.netIncome, item.eps, item.pegRatio, item.peRatio, item.psRatio, item.freeCashFlow, item.roe, item.roic, item.grossMargin, item.operatingMargin, item.reportedDate);
  });
  if (statements.length) await environment.DB.batch(statements);
}

export async function syncTickerFromFmp(environment, ticker) {
  // 기존 Worker 변수에 공급자명이 없던 배포도 FMP 키가 있으면 FMP를 기본값으로 사용한다.
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (provider !== 'FMP' || !environment.MARKET_DATA_API_KEY) throw new Error('FMP API 설정이 필요합니다.');
  const jobs = [
    ['profile', () => syncProfile(environment, ticker)], ['price', () => syncQuote(environment, ticker)], ['candles', () => syncCandles(environment, ticker)],
    ['dividends', () => syncDividends(environment, ticker)],
    ['financials', async () => { await syncFinancials(environment, ticker, 'annual', 10); await syncFinancials(environment, ticker, 'quarterly', 40); }]
  ];
  const result = {};
  for (const [dataType, task] of jobs) {
    try { await task(); await markSyncState(environment, ticker, dataType); result[dataType] = 'ok'; }
    catch (error) { await markSyncState(environment, ticker, dataType, error); result[dataType] = String(error); }
  }
  return result;
}
