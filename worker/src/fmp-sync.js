import { reserveFundamentalCall, blockFundamentalCall, ensureFundamentalStore } from './fundamental-store.js';
import { refreshWilliamsSignal } from './williams-store.js';

const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';
const SEC_FACTS_BASE_URL = 'https://data.sec.gov/api/xbrl/companyfacts';

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
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
  const isFundamental = !['quote', 'historical-price-eod/full'].includes(path);
  if (isFundamental) await reserveFundamentalCall(environment, path, params.symbol || 'market');
  const url = new URL(`${FMP_BASE_URL}/${path}`);
  url.searchParams.set('apikey', environment.MARKET_DATA_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (isFundamental) await blockFundamentalCall(environment, path, params.symbol || 'market', response.status);
    throw new Error(`FMP 요청 실패: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload?.['Error Message'] || payload?.error) throw new Error(payload['Error Message'] || payload.error);
  return payload;
}

/**
 * SEC Company Facts 요청을 한곳에서 처리한다.
 * SEC 공식 공시 원문은 재무와 기간별 배당금의 기준 출처로 사용한다.
 */
async function fetchSecCompanyFacts(environment, ticker) {
  if (environment.secFacts?.has(ticker)) return environment.secFacts.get(ticker);
  const company = await environment.DB.prepare('SELECT cik FROM companies WHERE ticker = ?').bind(ticker).first();
  const rawCik = String(company?.cik || '').replace(/\D/g, '');
  if (!rawCik) throw new Error('SEC CIK가 없어 공시 원문을 가져올 수 없습니다.');
  const cik = rawCik.padStart(10, '0');

  const response = await fetch(`${SEC_FACTS_BASE_URL}/CIK${cik}.json`, {
    signal: AbortSignal.timeout(20000),
    headers: {
      // SEC 정책에 따라 수집 주체를 식별한다. 운영 환경에서는 Secret의 연락처를 우선 사용한다.
      'User-Agent': environment.SEC_USER_AGENT || 'US Stock Pro dashboard contact: https://github.com/71yoyo/us-stock-dashboard',
      Accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`SEC EDGAR 요청 실패: HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.facts?.['us-gaap']) throw new Error('SEC EDGAR 공시 원문에 US-GAAP 데이터가 없습니다.');
  environment.secFacts?.set(ticker, payload.facts);
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
  const retryMinutes = httpStatus === '402'
    ? 30 * 24 * 60
    : httpStatus === '429'
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

export async function syncProfile(environment, ticker) {
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
  // 신규·수정 일봉을 저장한 뒤 신호를 다시 계산해 다음 로그인에서도 같은 상태를 유지한다.
  await refreshWilliamsSignal(environment, ticker);
}

/** FMP는 지급일·배당락일만 담당한다. SEC 기간 집계 테이블은 이 작업에서 건드리지 않는다. */
async function syncDividendEvents(environment, ticker) {
  const payload = asRecords(await fetchFmp(environment, 'dividends', { symbol: ticker }));
  const events = payload.map(row => ({
    exDate: String(row.date || row.exDividendDate || '').slice(0, 10),
    paymentDate: String(row.paymentDate || '').slice(0, 10) || null,
    declarationDate: String(row.declarationDate || '').slice(0, 10) || null,
    recordDate: String(row.recordDate || '').slice(0, 10) || null,
    amount: pickNumber(row, ['dividend', 'amount', 'adjDividend'])
  })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.exDate)
    && row.exDate >= isoDateBefore(760) && row.amount > 0);
  if (!events.length) throw new Error('FMP에서 지급일별 배당 이벤트를 받지 못했습니다. 기존 저장값은 유지합니다.');
  const unique = new Map(events.map(row => [row.exDate, row]));
  // 성공한 응답에 포함된 날짜만 교체해 정정 공시를 반영한다. API가 짧은 이력만 줘도 과거 캐시는 보존한다.
  const statements = [...unique.values()].flatMap(row => [
    environment.DB.prepare(`DELETE FROM dividend_events WHERE ticker=? AND source='FMP' AND ex_dividend_date=?`)
      .bind(ticker, row.exDate),
    environment.DB.prepare(`INSERT INTO dividend_events
      (ticker, declaration_date, ex_dividend_date, record_date, payment_date, amount, source_updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'FMP')`)
      .bind(ticker, row.declarationDate, row.exDate, row.recordDate, row.paymentDate, row.amount)
  ]);
  await environment.DB.batch(statements);
}

/** 달력상 정확히 1년·3개월 전을 구해 월 길이와 윤년 차이로 인한 오차를 막는다. */
function shiftCalendarMonths(isoDate, monthOffset) {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1 + monthOffset;
  const day = Number(dayText);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function receivedDate(event) {
  // "마지막 받은 배당금" 기준을 지키기 위해 지급일이 있으면 우선한다.
  return event.paymentDate || event.exDividendDate;
}

export function calculateDividendMetrics(events, currentPrice, today = new Date().toISOString().slice(0, 10)) {
  const datedEvents = events.map(event => ({ ...event, amount: toFiniteNumber(event.amount) }))
    .filter(event => event.exDividendDate && event.amount !== null)
    .sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
  const receivedEvents = datedEvents
    .filter(event => receivedDate(event) && receivedDate(event) <= today)
    .sort((left, right) => receivedDate(right).localeCompare(receivedDate(left)));

  // 주기 표기나 간격을 판별하지 않는다. 최근 실제 지급일 1년 구간만 합산하면
  // 분기배당은 보통 4회, 월배당은 보통 12회가 자연스럽게 포함된다.
  const trailingYearStart = shiftCalendarMonths(today, -12);
  const trailingYearPayouts = receivedEvents.filter(event => receivedDate(event) > trailingYearStart);
  const annualDividend = trailingYearPayouts.length
    ? trailingYearPayouts.reduce((total, event) => total + event.amount, 0) : null;

  const currentYear = Number(today.slice(0, 4));
  const annualAmounts = new Map();
  for (const event of datedEvents) {
    const year = event.exDividendDate.slice(0, 4);
    if (Number(year) >= currentYear) continue;
    annualAmounts.set(year, (annualAmounts.get(year) || 0) + event.amount);
  }
  const years = [...annualAmounts.keys()].sort();
  const latestYear = years.at(-1);
  const latestCompletedAnnualDividend = latestYear ? annualAmounts.get(latestYear) : null;
  const trailingQuarterStart = shiftCalendarMonths(today, -3);
  const trailingQuarterPayouts = receivedEvents.filter(event => receivedDate(event) > trailingQuarterStart);
  const quarterlyDividend = trailingQuarterPayouts.length
    ? trailingQuarterPayouts.reduce((total, event) => total + event.amount, 0) : null;

  let growthYears = 0;
  for (let index = years.length - 1; index > 0; index -= 1) {
    if (Number(years[index]) - Number(years[index - 1]) === 1
      && annualAmounts.get(years[index]) > annualAmounts.get(years[index - 1]) + 1e-9) growthYears += 1;
    else break;
  }
  const tenYearStart = annualAmounts.get(String(Number(latestYear) - 10));
  const yearSpan = 10;
  const growthCagr = tenYearStart && latestCompletedAnnualDividend && yearSpan > 0
    ? (Math.pow(latestCompletedAnnualDividend / tenYearStart, 1 / yearSpan) - 1) * 100
    : null;
  const futureEvent = datedEvents.find(event => event.exDividendDate >= today);
  // 월배당·불규칙 배당에 3개월을 일괄 더하면 잘못된 날짜가 되므로 미확인 일정은 비워 둔다.
  const nextExDate = futureEvent?.exDividendDate || null;
  const nextPaymentDate = futureEvent?.paymentDate || null;

  return {
    annualDividend,
    quarterlyDividend,
    dividendYield: annualDividend && currentPrice ? (annualDividend / currentPrice) * 100 : null,
    trailingPayoutCount: trailingYearPayouts.length,
    growthYears,
    growthCagr,
    nextExDate,
    nextPaymentDate,
    status: futureEvent ? 'confirmed' : 'unknown'
  };
}

/** SEC 공시의 주당배당금으로 10년 배당 집계값을 만든다. 정확한 배당락일은 임의 추정하지 않는다. */
export async function syncDividendsFromSec(environment, ticker) {
  await ensureFundamentalStore(environment);
  const facts = await fetchSecCompanyFacts(environment, ticker);
  const entries = selectSecFacts(facts, [
    'CommonStockDividendsPerShareDeclared',
    'CommonStockDividendsPerShareCashPaid'
  ], ['USD/shares']);
  const currentYear = new Date().getUTCFullYear();
  const annualValues = latestSecValues(entries, ['10-K', '10-K/A'], 1900, 'annual');
  const quarterlyValues = latestSecValues(entries, ['10-Q', '10-Q/A', '10-K', '10-K/A'], currentYear - 11, 'quarterly');
  const annualRecords = [...annualValues.values()]
    .filter(record => Number.isFinite(Number(record.val)) && Number(record.val) >= 0)
    .sort((left, right) => left.end.localeCompare(right.end))
    ;
  const quarterlyRecords = [...quarterlyValues.values()]
    .filter(record => Number.isFinite(Number(record.val)) && Number(record.val) >= 0)
    .sort((left, right) => left.end.localeCompare(right.end));

  if (!annualRecords.length && !quarterlyRecords.length) {
    throw new Error('SEC EDGAR에서 주당 배당금 공시를 찾지 못했습니다.');
  }

  const annualDividend = annualRecords.length ? Number(annualRecords.at(-1).val) : null;
  const recentQuarterDividend = quarterlyRecords.length ? Number(quarterlyRecords.at(-1).val) : null;
  let growthYears = 0;
  for (let index = annualRecords.length - 1; index > 0; index -= 1) {
    if (Number(annualRecords[index].end.slice(0, 4)) - Number(annualRecords[index - 1].end.slice(0, 4)) === 1
      && Number(annualRecords[index].val) > Number(annualRecords[index - 1].val) + 1e-9) growthYears += 1;
    else break;
  }
  const endYear = Number(annualRecords.at(-1)?.end.slice(0, 4));
  const firstAnnual = annualRecords.find(row => Number(row.end.slice(0, 4)) === endYear - 10)?.val;
  const yearSpan = 10;
  const growthCagr = firstAnnual > 0 && annualDividend > 0 && yearSpan > 0
    ? (Math.pow(annualDividend / firstAnnual, 1 / yearSpan) - 1) * 100
    : null;
  // SEC 연간·분기 집계만으로는 월배당/분기배당의 "최근 실제 지급 1년치"를 확정할 수 없다.
  // 따라서 FMP 지급 이벤트가 없는 종목의 수익률을 연간 공시값으로 대체하지 않는다.
  const dividendYield = null;

  await environment.DB.prepare(`INSERT INTO dividend_metrics
    (ticker, annual_dividend, quarterly_dividend, dividend_yield, dividend_growth_years, dividend_growth_cagr_10y,
      next_ex_dividend_date, next_date_status, next_payment_date, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET annual_dividend=excluded.annual_dividend,
      quarterly_dividend=excluded.quarterly_dividend, dividend_yield=excluded.dividend_yield,
      dividend_growth_years=excluded.dividend_growth_years, dividend_growth_cagr_10y=excluded.dividend_growth_cagr_10y,
      next_ex_dividend_date=NULL, next_date_status='unknown', next_payment_date=NULL,
      calculated_at=CURRENT_TIMESTAMP`).bind(
    ticker, annualDividend, recentQuarterDividend, dividendYield, growthYears, growthCagr
  ).run();
  const history = [['annual', annualRecords], ['quarterly', quarterlyRecords]];
  for (const [periodType, rows] of history) {
    const statements = rows.map(row => environment.DB.prepare(`INSERT INTO dividend_periods
      (ticker, period_type, period_end, amount, source, reported_date) VALUES (?, ?, ?, ?, 'SEC EDGAR', ?)
      ON CONFLICT(ticker, period_type, period_end) DO UPDATE SET amount=excluded.amount,
      source=excluded.source, reported_date=excluded.reported_date`)
      .bind(ticker, periodType, row.end, row.val, row.filed || null));
    if (statements.length) await environment.DB.batch(statements);
  }
  return { source: 'SEC EDGAR', annualCount: annualRecords.length, quarterlyCount: quarterlyRecords.length,
    firstDate: annualRecords[0]?.end, growthLimited: true, nextDateAvailable: false };
}

export function selectSecFacts(facts, tags, acceptedUnits) {
  const records = [];
  tags.forEach((tag, tagPriority) => {
    const fact = facts?.['us-gaap']?.[tag];
    if (!fact?.units) return;
    for (const unit of acceptedUnits) {
      if (!Array.isArray(fact.units[unit])) continue;
      // 회사와 연도에 따라 같은 지표의 표준 태그가 바뀌므로 후보 태그를 모두 합친다.
      records.push(...fact.units[unit].map(entry => ({ ...entry, tag, tagPriority })));
    }
  });
  return records;
}

function secDurationDays(entry) {
  if (!entry.start || !entry.end) return null;
  const duration = new Date(`${entry.end}T00:00:00Z`) - new Date(`${entry.start}T00:00:00Z`);
  return Number.isFinite(duration) ? Math.round(duration / 86_400_000) : null;
}

export function latestSecValues(entries, forms, minimumYear, periodType) {
  const records = new Map();
  const eligible = entries.filter(entry => entry.end && forms.includes(entry.form)
    && Number(entry.end.slice(0, 4)) >= minimumYear && Number.isFinite(entry.val));
  // 제출서류의 fp는 비교기간과 다를 수 있으므로 실제 start/end 기간 길이로 판정한다.
  const candidates = [...eligible];
  if (periodType === 'quarterly') {
    const cumulative = new Map();
    for (const entry of eligible) {
      if (!entry.start) continue;
      const key = `${entry.tag}:${entry.start}:${entry.end}`;
      if (!cumulative.has(key) || entry.filed > cumulative.get(key).filed) cumulative.set(key, entry);
    }
    const ordered = [...cumulative.values()].sort((a, b) => a.end.localeCompare(b.end));
    for (const entry of ordered) {
      if (secDurationDays(entry) < 150 || /EarningsPerShare/.test(entry.tag || '')) continue;
      const previous = ordered.findLast(row => row.tag === entry.tag && row.start === entry.start
        && row.end < entry.end && secDurationDays({ start: row.end, end: entry.end }) >= 60
        && secDurationDays({ start: row.end, end: entry.end }) <= 125);
      if (!previous) continue;
      const start = new Date(`${previous.end}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() + 1);
      candidates.push({ ...entry, start: start.toISOString().slice(0, 10), val: entry.val - previous.val,
        derived: true });
    }
  }
  for (const entry of candidates) {
    const durationDays = secDurationDays(entry);
    // 10-Q에는 3개월 값과 누적 6·9개월 값이 함께 들어온다. 막대그래프에는 개별 분기 값만 남긴다.
    if (durationDays !== null) {
      if (periodType === 'annual' && (durationDays < 330 || durationDays > 380)) continue;
      if (periodType === 'quarterly' && (durationDays < 60 || durationDays > 125)) continue;
    }
    if (durationDays === null && periodType === 'annual' && entry.fp !== 'FY') continue;
    const current = records.get(entry.end);
    const isNewerFiling = String(entry.filed || '') > String(current?.filed || '');
    const isPreferredTag = String(entry.filed || '') === String(current?.filed || '')
      && Number(entry.tagPriority ?? 999) < Number(current?.tagPriority ?? 999);
    // 같은 회계기간 수정 공시가 있다면 최신 제출분을, 같은 제출분이면 우선순위가 높은 태그를 쓴다.
    if (!current || (current.derived && !entry.derived)
      || (Boolean(current.derived) === Boolean(entry.derived) && (isNewerFiling || isPreferredTag))) records.set(entry.end, entry);
  }
  return records;
}

function valueAt(values, end) {
  return values.get(end)?.val ?? null;
}

export async function syncFinancialsFromSec(environment, ticker) {
  const facts = await fetchSecCompanyFacts(environment, ticker);
  const currentYear = new Date().getUTCFullYear();
  const minAnnualYear = currentYear - 10;
  const minQuarterYear = currentYear - 11;

  const usd = tags => selectSecFacts(facts, tags, ['USD']);
  const perShare = tags => selectSecFacts(facts, tags, ['USD/shares']);
  const revenue = usd(['RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
  const operatingIncome = usd(['OperatingIncomeLoss']);
  const operatingExpenses = usd(['OperatingExpenses']);
  const netInterestIncome = usd(['InterestIncomeExpenseNet']);
  const noninterestIncome = usd(['NoninterestIncome']);
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
  const dataSets = { revenue, netInterestIncome, noninterestIncome, operatingIncome, operatingExpenses, netIncome, operatingCashFlow, capitalExpenditure, grossProfit, equity, totalDebt, debtCurrent, debtNoncurrent, cash, eps };

  const writePeriod = async (periodType, forms, minimumYear, maximumRows) => {
    const dateSets = Object.fromEntries(Object.entries(dataSets)
      .map(([name, entries]) => [name, latestSecValues(entries, forms, minimumYear, periodType)]));
    // 잔액표의 날짜만으로 빈 손익 행이 생기지 않게 핵심 성과 지표가 있는 기간만 저장한다.
    const coreDateSets = ['revenue', 'netInterestIncome', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'eps']
      .map(name => dateSets[name]);
    const dates = [...new Set(coreDateSets.flatMap(data => [...data.keys()]))].sort().slice(-maximumRows);
    const statements = dates.map(end => {
      const interest = valueAt(dateSets.netInterestIncome, end);
      const noninterest = valueAt(dateSets.noninterestIncome, end);
      const revenueValue = valueAt(dateSets.revenue, end)
        ?? (interest !== null && noninterest !== null ? interest + noninterest : null);
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
      // 세후영업이익과 평균투하자본 검증 전에는 세전 단순비율을 ROIC로 표시하지 않는다.
      const roic = null;
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
    if (statements.length) {
      // 같은 종목/기간의 SEC 계산 캐시만 원자적으로 교체한다. 잘못 분류됐던 빈 연간·Q4 행을 정리한다.
      await environment.DB.batch([
        environment.DB.prepare(`DELETE FROM financial_metrics WHERE ticker = ? AND period_type = ?
          AND source = 'SEC EDGAR' AND fiscal_period_end NOT IN (${dates.map(() => '?').join(',')})`)
          .bind(ticker, periodType, ...dates),
        ...statements
      ]);
    }
    return statements.length;
  };

  const annualCount = await writePeriod('annual', ['10-K', '10-K/A'], minAnnualYear, 10);
  const quarterlyCount = await writePeriod('quarterly', ['10-Q', '10-Q/A', '10-K', '10-K/A'], minQuarterYear, 40);
  if (!annualCount && !quarterlyCount) throw new Error('SEC EDGAR 재무 원문에서 저장할 기간을 찾지 못했습니다.');
  return { source: 'SEC EDGAR', annualCount, quarterlyCount };
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
  // 재무·배당 기간 집계는 SEC 전용 큐, FMP는 개별 배당 이벤트만 수집한다.
  const allJobs = [
    ['profile', () => syncProfile(environment, ticker)],
    ['price', () => syncQuote(environment, ticker)],
    ['candles', () => syncCandles(environment, ticker)],
    ['dividends', () => syncDividendEvents(environment, ticker)]
  ];
  const unsupported = requestedDataTypes?.filter(dataType => !allJobs.some(([supported]) => supported === dataType));
  if (unsupported?.length) throw new Error(`FMP 동기화 대상이 아닙니다: ${unsupported.join(', ')}. 재무는 SEC 수집을 사용합니다.`);
  const jobs = requestedDataTypes
    ? allJobs.filter(([dataType]) => requestedDataTypes.includes(dataType))
    : allJobs;
  const result = {};
  for (const [dataType, task] of jobs) {
    try {
      await task();
      await markSyncState(environment, ticker, dataType);
      result[dataType] = 'ok';
    }
    catch (error) { await markSyncState(environment, ticker, dataType, error); result[dataType] = String(error); }
  }
  return result;
}

/**
 * 자동 수집 큐는 한 번에 한 데이터 종류만 처리한다.
 * 초기 적재 중에도 API 호출이 폭주하지 않고, 실패한 항목은 data_sync_state의 재시도 시각까지 건너뛴다.
 */
export async function syncTickerDataType(environment, ticker, dataType) {
  return syncTickerFromFmp(environment, ticker, [dataType]);
}

/**
 * 장기 이력은 최초 한 번 저장한 뒤, 데이터 성격별 주기에 맞춰서만 덮어쓴다.
 * 이 함수는 FMP 회사·시세·일봉·개별 배당 이벤트만 다룬다. 재무와 기간별 배당금은 SEC 큐에서 갱신한다.
 */
export async function syncTickerIncrementally(environment, ticker) {
  const states = await environment.DB.prepare(`SELECT data_type AS dataType, last_success_at AS lastSuccessAt,
    last_attempt_at AS lastAttemptAt, next_retry_at AS nextRetryAt
    FROM data_sync_state WHERE ticker = ?`).bind(ticker).all();
  const stateByType = new Map(states.results.map(state => [state.dataType, state]));
  const refreshRules = [
    ['price', 30],
    ['candles', 24 * 60],
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
