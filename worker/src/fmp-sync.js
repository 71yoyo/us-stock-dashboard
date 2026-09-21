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
  if (statements.length) await environment.DB.batch(statements);
}

function selectSecFact(facts, tags, acceptedUnits) {
  for (const tag of tags) {
    const fact = facts?.['us-gaap']?.[tag];
    if (!fact?.units) continue;
    for (const unit of acceptedUnits) {
      if (Array.isArray(fact.units[unit])) return fact.units[unit];
    }
  }
  return [];
}

function latestSecValues(entries, forms, minimumYear, periodType) {
  const records = new Map();
  for (const entry of entries) {
    if (!entry.end || !forms.includes(entry.form) || Number(entry.fy) < minimumYear) continue;
    const isRequestedPeriod = periodType === 'annual'
      ? entry.fp === 'FY'
      : ['Q1', 'Q2', 'Q3'].includes(entry.fp);
    if (!isRequestedPeriod) continue;
    const current = records.get(entry.end);
    // 같은 회계기간 수정 공시가 있다면 가장 나중에 제출된 값으로 덮어쓴다.
    if (!current || String(entry.filed || '') >= String(current.filed || '')) records.set(entry.end, entry);
  }
  return records;
}

function valueAt(values, end) {
  return values.get(end)?.val ?? null;
}

async function syncFinancialsFromSec(environment, ticker) {
  const company = await environment.DB.prepare('SELECT cik FROM companies WHERE ticker = ?').bind(ticker).first();
  const cik = String(company?.cik || '').replace(/\D/g, '').padStart(10, '0');
  if (cik.length !== 10) throw new Error('SEC CIK가 없어 재무 원문을 가져올 수 없습니다.');

  const response = await fetch(`${SEC_FACTS_BASE_URL}/CIK${cik}.json`, {
    headers: {
      // SEC는 자동 수집 주체를 식별할 수 있는 User-Agent를 요구한다. 운영 시 Secret으로 교체할 수 있다.
      'User-Agent': environment.SEC_USER_AGENT || 'US Stock Pro dashboard contact: https://github.com/71yoyo/us-stock-dashboard',
      Accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`SEC EDGAR 요청 실패: HTTP ${response.status}`);
  const payload = await response.json();
  const facts = payload.facts;
  const currentYear = new Date().getUTCFullYear();
  const minAnnualYear = currentYear - 10;
  const minQuarterYear = currentYear - 11;

  const usd = tags => selectSecFact(facts, tags, ['USD']);
  const perShare = tags => selectSecFact(facts, tags, ['USD/shares']);
  const revenue = usd(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
  const operatingIncome = usd(['OperatingIncomeLoss']);
  const netIncome = usd(['NetIncomeLoss', 'ProfitLoss']);
  const operatingCashFlow = usd(['NetCashProvidedByUsedInOperatingActivities']);
  const capitalExpenditure = usd(['PaymentsToAcquirePropertyPlantAndEquipment']);
  const grossProfit = usd(['GrossProfit']);
  const equity = usd(['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const debt = usd(['LongTermDebtCurrent', 'LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']);
  const cash = usd(['CashAndCashEquivalentsAtCarryingValue']);
  const eps = perShare(['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']);
  const dataSets = { revenue, operatingIncome, netIncome, operatingCashFlow, capitalExpenditure, grossProfit, equity, debt, cash, eps };

  const writePeriod = async (periodType, forms, minimumYear, maximumRows) => {
    const dateSets = Object.values(dataSets).map(entries => latestSecValues(entries, forms, minimumYear, periodType));
    const dates = [...new Set(dateSets.flatMap(data => [...data.keys()]))].sort().slice(-maximumRows);
    const statements = dates.map(end => {
      const revenueValue = valueAt(dateSets[0], end);
      const operatingIncomeValue = valueAt(dateSets[1], end);
      const netIncomeValue = valueAt(dateSets[2], end);
      const operatingCashFlowValue = valueAt(dateSets[3], end);
      const capitalExpenditureValue = valueAt(dateSets[4], end);
      const grossProfitValue = valueAt(dateSets[5], end);
      const equityValue = valueAt(dateSets[6], end);
      const debtValue = (valueAt(dateSets[7], end) || 0) + (valueAt(dateSets[8], end) || 0);
      const cashValue = valueAt(dateSets[8], end) || 0;
      const reportedDate = dateSets.map(values => values.get(end)?.filed).find(Boolean) || null;
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
      ).bind(ticker, periodType, end, reportedDate, revenueValue, operatingIncomeValue, netIncomeValue, valueAt(dateSets[9], end),
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

export async function syncTickerFromFmp(environment, ticker, requestedDataTypes = null) {
  // 기존 Worker 변수에 공급자명이 없던 배포도 FMP 키가 있으면 FMP를 기본값으로 사용한다.
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (provider !== 'FMP' || !environment.MARKET_DATA_API_KEY) throw new Error('FMP API 설정이 필요합니다.');
  const allJobs = [
    ['profile', () => syncProfile(environment, ticker)], ['price', () => syncQuote(environment, ticker)], ['candles', () => syncCandles(environment, ticker)],
    ['dividends', () => syncDividends(environment, ticker)],
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
  // 발표 일정은 재무 수집 실패와 별개로 갱신해 다음 Cron의 판단 재료로 쓴다.
  try { await syncEarningsSchedule(environment, ticker); result.earningsSchedule = 'ok'; }
  catch (error) { result.earningsSchedule = String(error); }
  return result;
}

/**
 * 장기 이력은 최초 한 번 저장한 뒤, 데이터 성격별 주기에 맞춰서만 덮어쓴다.
 * FMP 무료 호출 한도와 SEC의 공정 사용 정책을 함께 지키기 위한 증분 갱신 규칙이다.
 */
export async function syncTickerIncrementally(environment, ticker) {
  const states = await environment.DB.prepare(`SELECT data_type AS dataType, last_success_at AS lastSuccessAt
    FROM data_sync_state WHERE ticker = ?`).bind(ticker).all();
  const lastSuccessByType = new Map(states.results.map(state => [state.dataType, state.lastSuccessAt]));
  const refreshRules = [
    ['price', 30],
    ['candles', 24 * 60],
    ['dividends', 24 * 60],
    ['financials', 7 * 24 * 60],
    ['profile', 30 * 24 * 60]
  ];
  const requestedDataTypes = refreshRules
    .filter(([dataType, minutes]) => isStale(lastSuccessByType.get(dataType), minutes))
    .map(([dataType]) => dataType);
  if (await shouldRefreshFinancialsAfterEarnings(environment, ticker)) {
    requestedDataTypes.push('financials');
  }
  if (!requestedDataTypes.length) return { skipped: '최신 데이터가 이미 저장되어 있습니다.' };
  return syncTickerFromFmp(environment, ticker, requestedDataTypes);
}
