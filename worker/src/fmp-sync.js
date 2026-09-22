const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';
const SEC_FACTS_BASE_URL = 'https://data.sec.gov/api/xbrl/companyfacts';

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

function isoDateAfter(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
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

/**
 * SEC Company Facts 요청을 한곳에서 처리한다.
 * FMP 무료 범위에 없는 재무·배당 데이터는 공식 공시 원문으로 보완한다.
 */
async function fetchSecCompanyFacts(environment, ticker) {
  const company = await environment.DB.prepare('SELECT cik FROM companies WHERE ticker = ?').bind(ticker).first();
  const rawCik = String(company?.cik || '').replace(/\D/g, '');
  if (!rawCik) throw new Error('SEC CIK가 없어 공시 원문을 가져올 수 없습니다.');
  const cik = rawCik.padStart(10, '0');

  const response = await fetch(`${SEC_FACTS_BASE_URL}/CIK${cik}.json`, {
    headers: {
      // SEC 정책에 따라 수집 주체를 식별한다. 운영 환경에서는 Secret의 연락처를 우선 사용한다.
      'User-Agent': environment.SEC_USER_AGENT || 'US Stock Pro dashboard contact: https://github.com/71yoyo/us-stock-dashboard',
      Accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`SEC EDGAR 요청 실패: HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.facts?.['us-gaap']) throw new Error('SEC EDGAR 공시 원문에 US-GAAP 데이터가 없습니다.');
  return payload.facts;
}

async function markSyncState(environment, ticker, dataType, error = null) {
  const now = new Date().toISOString();
  if (!error) {
    return environment.DB.prepare(`INSERT INTO data_sync_state (ticker, data_type, last_success_at, last_attempt_at, next_retry_at, failure_count, last_error)
      VALUES (?, ?, ?, ?, NULL, 0, NULL)
      ON CONFLICT(ticker, data_type) DO UPDATE SET last_success_at=excluded.last_success_at, last_attempt_at=excluded.last_attempt_at, next_retry_at=NULL, failure_count=0, last_error=NULL`
    ).bind(ticker, dataType, now, now).run();
  }
  const previousState = await environment.DB.prepare(`SELECT failure_count AS failureCount
    FROM data_sync_state WHERE ticker = ? AND data_type = ?`).bind(ticker, dataType).first();
  const failureCount = Number(previousState?.failureCount || 0) + 1;
  const errorMessage = String(error).slice(0, 500);
  const httpStatus = errorMessage.match(/HTTP\s+(\d{3})/)?.[1];
  // 402·429는 플랜 또는 호출 제한일 수 있다. 짧은 간격으로 재시도하면 같은 실패를 반복하므로
  // 하루 동안 보류한다. SEC의 403은 공정 사용 제한 가능성을 고려해 6시간 뒤 다시 시도한다.
  const retryMinutes = ['402', '429'].includes(httpStatus)
    ? 24 * 60
    : httpStatus === '403'
      ? 6 * 60
      : Math.min(24 * 60, 15 * (2 ** Math.min(6, failureCount - 1)));
  const nextRetryAt = new Date(Date.now() + retryMinutes * 60_000).toISOString();

  // 오류 종류별 대기 시간을 명시적으로 저장해 Cron과 수동 동기화가 같은 API를 반복 호출하지 않게 한다.
  return environment.DB.prepare(`INSERT INTO data_sync_state (ticker, data_type, last_attempt_at, next_retry_at, failure_count, last_error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, data_type) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      failure_count=excluded.failure_count,
      next_retry_at=excluded.next_retry_at,
      last_error=excluded.last_error`
  ).bind(ticker, dataType, now, nextRetryAt, failureCount, errorMessage).run();
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
  // 빈 응답을 성공으로 저장하면 이후 대체 수집이 영구히 실행되지 않으므로 명시적으로 실패 처리한다.
  if (!events.length) throw new Error('FMP 배당 이력이 없습니다.');

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

/** SEC 공시의 주당배당금으로 10년 배당 집계값을 만든다. 정확한 배당락일은 임의 추정하지 않는다. */
async function syncDividendsFromSec(environment, ticker) {
  const facts = await fetchSecCompanyFacts(environment, ticker);
  const entries = selectSecFacts(facts, [
    'CommonStockDividendsPerShareDeclared',
    'CommonStockDividendsPerShareCashPaid'
  ], ['USD/shares']);
  const currentYear = new Date().getUTCFullYear();
  const annualValues = latestSecValues(entries, ['10-K', '10-K/A'], currentYear - 11, 'annual');
  const quarterlyValues = latestSecValues(entries, ['10-Q', '10-Q/A'], currentYear - 11, 'quarterly');
  const annualRecords = [...annualValues.values()]
    .filter(record => Number.isFinite(Number(record.val)) && Number(record.val) >= 0)
    .sort((left, right) => left.end.localeCompare(right.end))
    .slice(-10);
  const quarterlyRecords = [...quarterlyValues.values()]
    .filter(record => Number.isFinite(Number(record.val)) && Number(record.val) >= 0)
    .sort((left, right) => left.end.localeCompare(right.end));

  if (!annualRecords.length && !quarterlyRecords.length) {
    throw new Error('SEC EDGAR에서 주당 배당금 공시를 찾지 못했습니다.');
  }

  const annualDividend = annualRecords.length
    ? Number(annualRecords.at(-1).val)
    : quarterlyRecords.slice(-4).reduce((total, record) => total + Number(record.val), 0);
  const recentFourQuarterDividend = quarterlyRecords.length >= 4
    ? quarterlyRecords.slice(-4).reduce((total, record) => total + Number(record.val), 0)
    : annualDividend;
  let growthYears = 0;
  for (let index = annualRecords.length - 1; index > 0; index -= 1) {
    if (Number(annualRecords[index].val) + 1e-9 >= Number(annualRecords[index - 1].val)) growthYears += 1;
    else break;
  }
  const firstAnnual = annualRecords.length > 1 ? Number(annualRecords[0].val) : null;
  const yearSpan = annualRecords.length - 1;
  const growthCagr = firstAnnual > 0 && annualDividend > 0 && yearSpan > 0
    ? (Math.pow(annualDividend / firstAnnual, 1 / yearSpan) - 1) * 100
    : null;
  const quote = await environment.DB.prepare(`SELECT COALESCE(price_quotes.current_price, user_watchlist.saved_price) AS currentPrice
    FROM companies
    LEFT JOIN price_quotes ON price_quotes.ticker = companies.ticker
    LEFT JOIN user_watchlist ON user_watchlist.ticker = companies.ticker AND user_watchlist.user_id = 'primary'
    WHERE companies.ticker = ?`).bind(ticker).first();
  const currentPrice = toFiniteNumber(quote?.currentPrice);
  const dividendYield = annualDividend > 0 && currentPrice > 0 ? (annualDividend / currentPrice) * 100 : null;

  await environment.DB.prepare(`INSERT INTO dividend_metrics
    (ticker, annual_dividend, quarterly_dividend, dividend_yield, dividend_growth_years, dividend_growth_cagr_10y,
      next_ex_dividend_date, next_date_status, next_payment_date, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET annual_dividend=excluded.annual_dividend,
      quarterly_dividend=excluded.quarterly_dividend, dividend_yield=excluded.dividend_yield,
      dividend_growth_years=excluded.dividend_growth_years, dividend_growth_cagr_10y=excluded.dividend_growth_cagr_10y,
      calculated_at=CURRENT_TIMESTAMP`).bind(
    ticker, annualDividend, recentFourQuarterDividend, dividendYield, growthYears, growthCagr
  ).run();
}

async function syncEarningsSchedule(environment, ticker) {
  const records = asRecords(await fetchFmp(environment, 'earnings', { symbol: ticker }));
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = records
    .map(record => ({
      date: toIsoDate(record.date || record.earningsDate),
      // FMP가 실제 EPS를 제공한 과거 행은 확정 일정으로 취급하지 않는다.
      hasActualResult: pickNumber(record, ['epsActual', 'actualEps']) !== null
    }))
    .filter(record => record.date && record.date >= today && !record.hasActualResult)
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  // 개별 이력 API에 미래 행이 없으면 시장 전체 실적 캘린더에서 해당 티커만 찾는다.
  const calendar = upcoming ? [] : asRecords(await fetchFmp(environment, 'earnings-calendar', {
    from: today,
    to: isoDateAfter(365)
  }));
  const calendarEvent = calendar
    .filter(record => String(record.symbol || record.ticker || '').toUpperCase() === ticker)
    .map(record => ({ date: toIsoDate(record.date || record.earningsDate) }))
    .filter(record => record.date && record.date >= today)
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  const scheduledEvent = upcoming || calendarEvent;

  await environment.DB.prepare(`INSERT INTO earnings_schedule
    (ticker, next_earnings_date, is_confirmed, source, last_checked_at, last_error, updated_at)
    VALUES (?, ?, ?, 'FMP', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET next_earnings_date=excluded.next_earnings_date,
      is_confirmed=excluded.is_confirmed, source='FMP', last_checked_at=CURRENT_TIMESTAMP,
      last_error=NULL, updated_at=CURRENT_TIMESTAMP`
  ).bind(ticker, scheduledEvent?.date || null, scheduledEvent ? 1 : 0).run();
}

async function getNextUsTradingDate(environment, isoDate) {
  const cursor = new Date(`${isoDate}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const candidate = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    const holiday = await environment.DB.prepare(`SELECT 1 FROM market_holidays
      WHERE market = 'NYSE' AND holiday_date = ? AND is_full_close = 1`).bind(candidate).first();
    if (day !== 0 && day !== 6 && !holiday) return candidate;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

async function shouldRefreshFinancialsAfterEarnings(environment, ticker) {
  const schedule = await environment.DB.prepare(`SELECT next_earnings_date AS nextEarningsDate,
    last_checked_at AS lastCheckedAt, last_financial_refresh_at AS lastFinancialRefreshAt
    FROM earnings_schedule WHERE ticker = ?`).bind(ticker).first();
  const today = new Date().toISOString().slice(0, 10);
  const scheduleIsStale = !schedule?.lastCheckedAt || isStale(schedule.lastCheckedAt, 24 * 60);

  if (scheduleIsStale) {
    try {
      await syncEarningsSchedule(environment, ticker);
    } catch (error) {
      await environment.DB.prepare(`INSERT INTO earnings_schedule (ticker, source, last_checked_at, last_error, updated_at)
        VALUES (?, 'FMP', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(ticker) DO UPDATE SET last_checked_at=CURRENT_TIMESTAMP, last_error=excluded.last_error, updated_at=CURRENT_TIMESTAMP`
      ).bind(ticker, String(error).slice(0, 500)).run();
    }
  }

  const refreshedSchedule = await environment.DB.prepare(`SELECT next_earnings_date AS nextEarningsDate,
    last_financial_refresh_at AS lastFinancialRefreshAt FROM earnings_schedule WHERE ticker = ?`).bind(ticker).first();
  if (refreshedSchedule?.nextEarningsDate) {
    const refreshDate = await getNextUsTradingDate(environment, refreshedSchedule.nextEarningsDate);
    if (refreshDate && today >= refreshDate && String(refreshedSchedule.lastFinancialRefreshAt || '') < refreshDate) {
      return true;
    }
    return false;
  }

  // 발표일이 없는 종목·ETF는 새 공시를 놓치지 않도록 기존 주 1회 확인을 안전망으로 둔다.
  return isStale(refreshedSchedule?.lastFinancialRefreshAt, 7 * 24 * 60);
}

async function markFinancialsRefreshed(environment, ticker) {
  await environment.DB.prepare(`INSERT INTO earnings_schedule
    (ticker, source, last_financial_refresh_at, updated_at)
    VALUES (?, 'FMP', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET last_financial_refresh_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`
  ).bind(ticker).run();
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
  if (!statements.length) throw new Error(`FMP ${periodType === 'annual' ? '연간' : '분기'} 재무 데이터가 없습니다.`);
  await environment.DB.batch(statements);
}

function selectSecFacts(facts, tags, acceptedUnits) {
  const records = [];
  tags.forEach((tag, tagPriority) => {
    const fact = facts?.['us-gaap']?.[tag];
    if (!fact?.units) return;
    for (const unit of acceptedUnits) {
      if (!Array.isArray(fact.units[unit])) continue;
      // 회사와 연도에 따라 같은 지표의 표준 태그가 바뀌므로 후보 태그를 모두 합친다.
      records.push(...fact.units[unit].map(entry => ({ ...entry, tagPriority })));
    }
  });
  return records;
}

function secDurationDays(entry) {
  if (!entry.start || !entry.end) return null;
  const duration = new Date(`${entry.end}T00:00:00Z`) - new Date(`${entry.start}T00:00:00Z`);
  return Number.isFinite(duration) ? Math.round(duration / 86_400_000) : null;
}

function latestSecValues(entries, forms, minimumYear, periodType) {
  const records = new Map();
  for (const entry of entries) {
    if (!entry.end || !forms.includes(entry.form) || Number(entry.fy) < minimumYear) continue;
    const isRequestedPeriod = periodType === 'annual'
      ? entry.fp === 'FY'
      : ['Q1', 'Q2', 'Q3'].includes(entry.fp);
    if (!isRequestedPeriod) continue;
    const durationDays = secDurationDays(entry);
    // 10-Q에는 3개월 값과 누적 6·9개월 값이 함께 들어온다. 막대그래프에는 개별 분기 값만 남긴다.
    if (durationDays !== null) {
      if (periodType === 'annual' && (durationDays < 250 || durationDays > 380)) continue;
      if (periodType === 'quarterly' && (durationDays < 60 || durationDays > 125)) continue;
    }
    const current = records.get(entry.end);
    const isNewerFiling = String(entry.filed || '') > String(current?.filed || '');
    const isPreferredTag = String(entry.filed || '') === String(current?.filed || '')
      && Number(entry.tagPriority ?? 999) < Number(current?.tagPriority ?? 999);
    // 같은 회계기간 수정 공시가 있다면 최신 제출분을, 같은 제출분이면 우선순위가 높은 태그를 쓴다.
    if (!current || isNewerFiling || isPreferredTag) records.set(entry.end, entry);
  }
  return records;
}

function valueAt(values, end) {
  return values.get(end)?.val ?? null;
}

async function syncFinancialsFromSec(environment, ticker) {
  const facts = await fetchSecCompanyFacts(environment, ticker);
  const currentYear = new Date().getUTCFullYear();
  const minAnnualYear = currentYear - 10;
  const minQuarterYear = currentYear - 11;

  const usd = tags => selectSecFacts(facts, tags, ['USD']);
  const perShare = tags => selectSecFacts(facts, tags, ['USD/shares']);
  const revenue = usd(['RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
  const operatingIncome = usd(['OperatingIncomeLoss']);
  const operatingExpenses = usd(['OperatingExpenses', 'CostsAndExpenses']);
  const netIncome = usd(['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic']);
  const operatingCashFlow = usd(['NetCashProvidedByUsedInOperatingActivities']);
  const capitalExpenditure = usd(['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireRealEstate', 'PaymentsToAcquireProductiveAssets']);
  const grossProfit = usd(['GrossProfit']);
  const equity = usd(['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const totalDebt = usd(['LongTermDebtAndFinanceLeaseObligations', 'LongTermDebt']);
  const debtCurrent = usd(['LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent']);
  const debtNoncurrent = usd(['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']);
  const cash = usd(['CashAndCashEquivalentsAtCarryingValue']);
  const eps = perShare(['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']);
  const dataSets = { revenue, operatingIncome, operatingExpenses, netIncome, operatingCashFlow, capitalExpenditure, grossProfit, equity, totalDebt, debtCurrent, debtNoncurrent, cash, eps };

  const writePeriod = async (periodType, forms, minimumYear, maximumRows) => {
    const dateSets = Object.fromEntries(Object.entries(dataSets)
      .map(([name, entries]) => [name, latestSecValues(entries, forms, minimumYear, periodType)]));
    // 잔액표의 날짜만으로 빈 손익 행이 생기지 않게 핵심 성과 지표가 있는 기간만 저장한다.
    const coreDateSets = ['revenue', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'eps']
      .map(name => dateSets[name]);
    const dates = [...new Set(coreDateSets.flatMap(data => [...data.keys()]))].sort().slice(-maximumRows);
    const statements = dates.map(end => {
      const revenueValue = valueAt(dateSets.revenue, end);
      const reportedOperatingIncome = valueAt(dateSets.operatingIncome, end);
      const operatingExpensesValue = valueAt(dateSets.operatingExpenses, end);
      const operatingIncomeValue = reportedOperatingIncome !== null
        ? reportedOperatingIncome
        : revenueValue !== null && operatingExpensesValue !== null ? revenueValue - operatingExpensesValue : null;
      const netIncomeValue = valueAt(dateSets.netIncome, end);
      const operatingCashFlowValue = valueAt(dateSets.operatingCashFlow, end);
      const capitalExpenditureValue = valueAt(dateSets.capitalExpenditure, end);
      const grossProfitValue = valueAt(dateSets.grossProfit, end);
      const equityValue = valueAt(dateSets.equity, end);
      const reportedTotalDebt = valueAt(dateSets.totalDebt, end);
      const debtParts = [valueAt(dateSets.debtCurrent, end), valueAt(dateSets.debtNoncurrent, end)].filter(value => value !== null);
      const debtValue = reportedTotalDebt ?? (debtParts.length ? debtParts.reduce((total, value) => total + value, 0) : 0);
      const cashValue = valueAt(dateSets.cash, end) || 0;
      const reportedDate = Object.values(dateSets).map(values => values.get(end)?.filed).find(Boolean) || null;
      const freeCashFlow = operatingCashFlowValue !== null && capitalExpenditureValue !== null
        ? operatingCashFlowValue - Math.abs(capitalExpenditureValue) : null;
      const grossMargin = grossProfitValue !== null && revenueValue ? (grossProfitValue / revenueValue) * 100 : null;
      const operatingMargin = operatingIncomeValue !== null && revenueValue ? (operatingIncomeValue / revenueValue) * 100 : null;
      const investedCapital = equityValue !== null ? equityValue + debtValue - cashValue : null;
      const roic = operatingIncomeValue !== null && investedCapital ? (operatingIncomeValue / investedCapital) * 100 : null;
      const roe = netIncomeValue !== null && equityValue ? (netIncomeValue / equityValue) * 100 : null;
      return environment.DB.prepare(`INSERT INTO financial_metrics (ticker, period_type, fiscal_period_end, reported_date, currency, revenue, operating_income, net_income, eps, free_cash_flow, roe, roic, gross_margin, operating_margin, source, source_updated_at, cached_at)
        VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEC EDGAR', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(ticker, period_type, fiscal_period_end) DO UPDATE SET reported_date=excluded.reported_date, revenue=excluded.revenue,
          operating_income=excluded.operating_income, net_income=excluded.net_income, eps=excluded.eps, free_cash_flow=excluded.free_cash_flow,
          roe=excluded.roe, roic=excluded.roic, gross_margin=excluded.gross_margin, operating_margin=excluded.operating_margin,
          source=excluded.source, source_updated_at=excluded.source_updated_at, cached_at=CURRENT_TIMESTAMP`
      ).bind(ticker, periodType, end, reportedDate, revenueValue, operatingIncomeValue, netIncomeValue, valueAt(dateSets.eps, end),
        freeCashFlow, roe, roic, grossMargin, operatingMargin, reportedDate);
    });
    if (statements.length) await environment.DB.batch(statements);
    return statements.length;
  };

  const annualCount = await writePeriod('annual', ['10-K', '10-K/A'], minAnnualYear, 10);
  const quarterlyCount = await writePeriod('quarterly', ['10-Q', '10-Q/A'], minQuarterYear, 40);
  if (!annualCount && !quarterlyCount) throw new Error('SEC EDGAR 재무 원문에서 저장할 기간을 찾지 못했습니다.');
}

function isStale(lastSuccessAt, minutes) {
  if (!lastSuccessAt) return true;
  const elapsed = Date.now() - new Date(lastSuccessAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= minutes * 60_000;
}

export async function syncTickerFromFmp(environment, ticker, requestedDataTypes = null, options = {}) {
  // 기존 Worker 변수에 공급자명이 없던 배포도 FMP 키가 있으면 FMP를 기본값으로 사용한다.
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (provider !== 'FMP' || !environment.MARKET_DATA_API_KEY) throw new Error('FMP API 설정이 필요합니다.');
  const allJobs = [
    ['profile', () => syncProfile(environment, ticker)], ['price', () => syncQuote(environment, ticker)], ['candles', () => syncCandles(environment, ticker)],
    ['dividends', async () => {
      try {
        await syncDividends(environment, ticker);
      } catch (fmpError) {
        // FMP 무료 플랜에서 배당 이력이 제한되면 SEC의 공식 주당배당금 공시로 집계값을 채운다.
        await syncDividendsFromSec(environment, ticker);
      }
    }],
    ['financials', async () => {
      try {
        await syncFinancials(environment, ticker, 'annual', 10);
        await syncFinancials(environment, ticker, 'quarterly', 40);
      } catch (fmpError) {
        // FMP 무료 플랜이 장기 재무 요청을 제한하면 공식 SEC 원문으로 자동 보완한다.
        await syncFinancialsFromSec(environment, ticker);
      }
    }]
  ];
  const jobs = requestedDataTypes
    ? allJobs.filter(([dataType]) => requestedDataTypes.includes(dataType))
    : allJobs;
  const result = {};
  for (const [dataType, task] of jobs) {
    try {
      await task();
      await markSyncState(environment, ticker, dataType);
      if (dataType === 'financials') await markFinancialsRefreshed(environment, ticker);
      result[dataType] = 'ok';
    }
    catch (error) { await markSyncState(environment, ticker, dataType, error); result[dataType] = String(error); }
  }
  // 실적 일정은 재무 작업 때만 확인한다. 가격·차트 한 건을 갱신하면서 추가 API를 호출하지 않는다.
  if (options.syncEarningsSchedule) {
    try { await syncEarningsSchedule(environment, ticker); result.earningsSchedule = 'ok'; }
    catch (error) { result.earningsSchedule = String(error); }
  }
  return result;
}

/**
 * 자동 수집 큐는 한 번에 한 데이터 종류만 처리한다.
 * 초기 적재 중에도 API 호출이 폭주하지 않고, 실패한 항목은 data_sync_state의 재시도 시각까지 건너뛴다.
 */
export async function syncTickerDataType(environment, ticker, dataType) {
  return syncTickerFromFmp(environment, ticker, [dataType], {
    syncEarningsSchedule: dataType === 'financials'
  });
}

/**
 * 장기 이력은 최초 한 번 저장한 뒤, 데이터 성격별 주기에 맞춰서만 덮어쓴다.
 * FMP 무료 호출 한도와 SEC의 공정 사용 정책을 함께 지키기 위한 증분 갱신 규칙이다.
 */
export async function syncTickerIncrementally(environment, ticker) {
  const [states, coverage] = await environment.DB.batch([
    environment.DB.prepare(`SELECT data_type AS dataType, last_success_at AS lastSuccessAt,
      last_attempt_at AS lastAttemptAt, next_retry_at AS nextRetryAt
      FROM data_sync_state WHERE ticker = ?`).bind(ticker),
    environment.DB.prepare(`SELECT
      CASE WHEN EXISTS (
        SELECT 1 FROM financial_metrics WHERE ticker = ? AND period_type = 'quarterly'
          AND fiscal_period_end >= date('now', '-18 months') AND revenue IS NOT NULL AND net_income IS NOT NULL
      ) THEN 1 ELSE 0 END AS hasUsableFinancials,
      CASE WHEN EXISTS (
        SELECT 1 FROM dividend_metrics WHERE ticker = ? AND annual_dividend IS NOT NULL
      ) THEN 1 ELSE 0 END AS hasDividendMetrics`).bind(ticker, ticker)
  ]);
  const stateByType = new Map(states.results.map(state => [state.dataType, state]));
  const coverageState = coverage.results[0] || {};
  const missingDataTypes = [
    Number(coverageState.hasDividendMetrics) !== 1 ? 'dividends' : null,
    Number(coverageState.hasUsableFinancials) !== 1 ? 'financials' : null
  ].filter(dataType => {
    if (!dataType) return false;
    const syncState = stateByType.get(dataType);
    const lastAttemptTime = new Date(syncState?.lastAttemptAt || 0).getTime();
    // 실제 저장값이 없으면 과거 FMP 장기 보류보다 사용자의 재시도를 우선하되, 연속 클릭은 1분간 막는다.
    return !Number.isFinite(lastAttemptTime) || Date.now() - lastAttemptTime >= 60_000;
  });
  if (missingDataTypes.length) {
    // 사용자가 상세창을 연 경우 비어 있는 핵심 데이터 두 종류는 한 번의 요청에서 즉시 복구한다.
    return syncTickerFromFmp(environment, ticker, missingDataTypes, {
      syncEarningsSchedule: missingDataTypes.includes('financials')
    });
  }
  const refreshRules = [
    ['price', 30],
    ['candles', 24 * 60],
    ['dividends', 24 * 60],
    ['financials', 7 * 24 * 60],
    ['profile', 30 * 24 * 60]
  ];
  const requestedDataTypes = refreshRules
    .filter(([dataType, minutes]) => {
      const syncState = stateByType.get(dataType);
      const retryIsAllowed = !syncState?.nextRetryAt || new Date(syncState.nextRetryAt).getTime() <= Date.now();
      return retryIsAllowed && isStale(syncState?.lastSuccessAt, minutes);
    })
    .map(([dataType]) => dataType);
  if (!requestedDataTypes.length) return { skipped: '최신 데이터가 이미 저장되어 있습니다.' };
  // 수동 요청도 전체 묶음을 즉시 실행하지 않고, 가장 우선인 한 작업만 큐에 넣는 방식으로 처리한다.
  return syncTickerDataType(environment, ticker, requestedDataTypes[0]);
}
