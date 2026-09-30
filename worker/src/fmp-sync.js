import { reserveFundamentalCall, blockFundamentalCall, ensureFundamentalStore } from './fundamental-store.js';
import { refreshWilliamsSignal } from './williams-store.js';
import { MassiveCandlePendingError, MassiveCandleUnavailableError, syncCandlesFromMassive } from './massive-sync.js';
import { SEC_FINANCIAL_METADATA_VERSION, secDifferenceMetadata, buildSecPeriodIndex,
  resolveSecPeriodMetadata, buildFinancialProvenance, financialProvenanceStatements } from './sec-financial-metadata.js';

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
 * SEC 공식 공시 원문은 재무 지표의 기준 출처로만 사용한다.
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
  // 일봉의 재시도 시각은 기본 공급원 Massive 오류를 기준으로 정하고, 보조 FMP 402는 별도 기록한다.
  const retryError = errorMessage.startsWith('일봉 수집 실패: ')
    ? errorMessage.split('; FMP 보조 실패:')[0] : errorMessage;
  const httpStatus = retryError.match(/HTTP\s+(\d{3})/)?.[1];
  // 402·429는 플랜 또는 호출 제한일 수 있다. 짧은 간격으로 재시도하면 같은 실패를 반복하므로
  // 하루 동안 보류한다. SEC의 403은 공정 사용 제한 가능성을 고려해 6시간 뒤 다시 시도한다.
  const retryMinutes = error instanceof MassiveCandlePendingError ? 15 : httpStatus === '402'
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

async function syncCandles(environment, ticker, minimumDate = null) {
  // Massive가 기본 일봉 공급원이다. 무료 호출 예산이 찬 경우에는 FMP로 우회하지 않고 다음 주기를 기다린다.
  try {
    return await syncCandlesFromMassive(environment, ticker, minimumDate);
  } catch (massiveError) {
    // D1 저장·신호 계산 오류는 공급원 문제가 아니므로 FMP로 덮어쓰지 않는다.
    if (!(massiveError instanceof MassiveCandleUnavailableError)) throw massiveError;
    if (!environment.MARKET_DATA_API_KEY) throw massiveError;
    const block = await environment.DB.prepare(`SELECT retry_at AS retryAt FROM fmp_candle_blocks
      WHERE ticker=?`).bind(ticker).first();
    if (block?.retryAt && block.retryAt > new Date().toISOString()) throw massiveError;
    try {
      return await syncCandlesFromFmpFallback(environment, ticker);
    } catch (fmpError) {
      if (/HTTP 402/.test(String(fmpError))) {
        // 종목별 권한 오류는 짧은 재시도에 의미가 없으므로 한 달간 FMP 보조 요청을 멈춘다.
        await environment.DB.prepare(`INSERT INTO fmp_candle_blocks(ticker, retry_at, reason) VALUES (?, ?, ?)
          ON CONFLICT(ticker) DO UPDATE SET retry_at=excluded.retry_at, reason=excluded.reason`)
          .bind(ticker, new Date(Date.now() + 30 * 86_400_000).toISOString(), String(fmpError)).run();
      }
      throw new Error(`일봉 수집 실패: Massive ${String(massiveError.message || massiveError)}; FMP 보조 실패: ${String(fmpError.message || fmpError)}`);
    }
  }
}

/** Massive가 실제로 실패했을 때만 FMP의 전체 3개월 응답을 검증해 보조 저장한다. */
async function syncCandlesFromFmpFallback(environment, ticker) {
  const fromDate = isoDateBefore(100);
  const records = asRecords(await fetchFmp(environment, 'historical-price-eod/full', { symbol: ticker, from: fromDate }))
    .filter(row => row.date && ['open', 'high', 'low', 'close'].every(key => toFiniteNumber(row[key]) > 0));
  if (!records.length) throw new Error('FMP 보조 일봉 응답이 비어 있습니다.');
  const existing = await environment.DB.prepare(`SELECT COUNT(*) AS count FROM price_candles
    WHERE ticker=? AND source='MASSIVE' AND candle_date>=?`).bind(ticker, fromDate).first();
  if (Number(existing?.count) >= 20 && records.length < Math.ceil(Number(existing.count) * 0.8)) {
    throw new Error('FMP 보조 일봉 범위가 기존 Massive 이력보다 짧아 저장하지 않았습니다.');
  }
  const normalized = records.map(row => ({ date: row.date, open: toFiniteNumber(row.open),
    high: toFiniteNumber(row.high), low: toFiniteNumber(row.low), close: toFiniteNumber(row.close),
    adjustedClose: pickNumber(row, ['adjClose', 'adjustedClose']), volume: toFiniteNumber(row.volume) }));
  await environment.DB.batch([
    // 일시적 FMP 보조 응답도 향후 Massive 교체 전 복구 가능한 원본으로 남긴다.
    environment.DB.prepare(`INSERT OR IGNORE INTO archived_fmp_candles
      (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, cached_at)
      SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.open'),
        json_extract(value, '$.high'), json_extract(value, '$.low'), json_extract(value, '$.close'),
        json_extract(value, '$.adjustedClose'), json_extract(value, '$.volume'), CURRENT_TIMESTAMP
      FROM json_each(?)`).bind(ticker, JSON.stringify(normalized)),
    // Massive가 이미 저장한 날짜는 일시적인 보조 공급원 값으로 덮지 않는다.
    environment.DB.prepare(`INSERT INTO price_candles
    (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source, cached_at)
    SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.open'),
      json_extract(value, '$.high'), json_extract(value, '$.low'), json_extract(value, '$.close'),
      json_extract(value, '$.adjustedClose'), json_extract(value, '$.volume'), 'FMP', CURRENT_TIMESTAMP
    FROM json_each(?) WHERE 1
    ON CONFLICT(ticker, candle_date) DO UPDATE SET open_price=excluded.open_price, high_price=excluded.high_price,
      low_price=excluded.low_price, close_price=excluded.close_price, adjusted_close=excluded.adjusted_close,
    volume=excluded.volume, source=excluded.source, cached_at=CURRENT_TIMESTAMP
    WHERE price_candles.source <> 'MASSIVE'`
    ).bind(ticker, JSON.stringify(normalized))
  ]);
  await refreshWilliamsSignal(environment, ticker);
  return { source: 'FMP', count: normalized.length };
}

export function selectSecFacts(facts, tags, acceptedUnits) {
  const records = [];
  tags.forEach((tag, tagPriority) => {
    const fact = facts?.['us-gaap']?.[tag];
    if (!fact?.units) return;
    for (const unit of acceptedUnits) {
      if (!Array.isArray(fact.units[unit])) continue;
      // 회사와 연도에 따라 같은 지표의 표준 태그가 바뀌므로 후보 태그를 모두 합친다.
      // 단위는 SEC의 units 키에 있으므로 원본 fact와 함께 명시적으로 보존한다.
      records.push(...fact.units[unit].map(entry => ({ ...entry, tag, tagPriority, unit, taxonomy: 'us-gaap' })));
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
        derived: true, ...secDifferenceMetadata(entry, previous) });
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
  // 최신 비교값의 fy/fp를 과거 기간에 복사하지 않고, 원본 공시별 현재 기간으로 식별한다.
  const periodIndex = buildSecPeriodIndex(dataSets);
  const metadataCoverage = { annual: 0, quarterly: 0, provenance: 0 };

  const writePeriod = async (periodType, forms, minimumYear, maximumRows) => {
    const dateSets = Object.fromEntries(Object.entries(dataSets)
      .map(([name, entries]) => [name, latestSecValues(entries, forms, minimumYear, periodType)]));
    // 잔액표의 날짜만으로 빈 손익 행이 생기지 않게 핵심 성과 지표가 있는 기간만 저장한다.
    const coreDateSets = ['revenue', 'netInterestIncome', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'eps']
      .map(name => dateSets[name]);
    const dates = [...new Set(coreDateSets.flatMap(data => [...data.keys()]))].sort().slice(-maximumRows);
    const provenance = [];
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
      const periodMetadata = resolveSecPeriodMetadata(periodIndex, periodType, end,
        coreDateSets.map(values => values.get(end)));
      if (periodMetadata.fiscalYear !== null && periodMetadata.fiscalPeriod !== null) metadataCoverage[periodType] += 1;
      provenance.push(...buildFinancialProvenance(dateSets, end, {
        revenue: revenueValue, operatingIncome: operatingIncomeValue, freeCashFlow, roe, grossMargin, operatingMargin
      }).map(record => ({ ...record, fiscalPeriodEnd: end })));
      return environment.DB.prepare(`INSERT INTO financial_metrics (ticker, period_type, fiscal_period_end, reported_date, currency, revenue, operating_income, net_income, eps, free_cash_flow, roe, roic, gross_margin, operating_margin, source, source_updated_at, cached_at, fiscal_year, fiscal_period, period_start)
        VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEC EDGAR', ?, CURRENT_TIMESTAMP, ?, ?, ?)
        ON CONFLICT(ticker, period_type, fiscal_period_end) DO UPDATE SET reported_date=excluded.reported_date, revenue=excluded.revenue,
          operating_income=excluded.operating_income, net_income=excluded.net_income, eps=excluded.eps, free_cash_flow=excluded.free_cash_flow,
          roe=excluded.roe, roic=excluded.roic, gross_margin=excluded.gross_margin, operating_margin=excluded.operating_margin,
          source=excluded.source, source_updated_at=excluded.source_updated_at, cached_at=CURRENT_TIMESTAMP,
          fiscal_year=excluded.fiscal_year, fiscal_period=excluded.fiscal_period, period_start=excluded.period_start`
      ).bind(ticker, periodType, end, reportedDate, revenueValue, operatingIncomeValue, netIncomeValue, valueAt(dateSets.eps, end),
        freeCashFlow, roe, roic, grossMargin, operatingMargin, reportedDate,
        periodMetadata.fiscalYear, periodMetadata.fiscalPeriod, periodMetadata.periodStart);
    });
    if (statements.length) {
      // 같은 종목/기간의 SEC 계산 캐시만 원자적으로 교체한다. 잘못 분류됐던 빈 연간·Q4 행을 정리한다.
      await environment.DB.batch([
        environment.DB.prepare(`DELETE FROM financial_metrics WHERE ticker = ? AND period_type = ?
          AND source = 'SEC EDGAR' AND fiscal_period_end NOT IN (${dates.map(() => '?').join(',')})`)
          .bind(ticker, periodType, ...dates),
        ...statements,
        ...financialProvenanceStatements(environment, ticker, periodType, provenance)
      ]);
      metadataCoverage.provenance += provenance.length;
    }
    return statements.length;
  };

  const annualCount = await writePeriod('annual', ['10-K', '10-K/A'], minAnnualYear, 10);
  const quarterlyCount = await writePeriod('quarterly', ['10-Q', '10-Q/A', '10-K', '10-K/A'], minQuarterYear, 40);
  if (!annualCount && !quarterlyCount) throw new Error('SEC EDGAR 재무 원문에서 저장할 기간을 찾지 못했습니다.');
  return { source: 'SEC EDGAR', annualCount, quarterlyCount,
    metadataVersion: SEC_FINANCIAL_METADATA_VERSION, metadataCoverage };
}

function isStale(lastSuccessAt, minutes) {
  if (!lastSuccessAt) return true;
  const elapsed = Date.now() - new Date(lastSuccessAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= minutes * 60_000;
}

export async function syncTickerFromFmp(environment, ticker, requestedDataTypes = null, options = {}) {
  // 변수명과 함수명은 이전 배포 호환용이다. 일봉은 Massive, 회사·시세는 기존 FMP를 사용한다.
  const provider = String(environment.MARKET_DATA_PROVIDER || 'FMP').trim().toUpperCase();
  if (!['FMP', 'MASSIVE'].includes(provider)) throw new Error('금융 API 공급자 설정을 확인해 주세요.');
  const allJobs = [
    ['profile', () => syncProfile(environment, ticker)],
    ['price', () => syncQuote(environment, ticker)],
    ['candles', () => syncCandles(environment, ticker, options.minimumCandleDate)]
  ];
  const unsupported = requestedDataTypes?.filter(dataType => !allJobs.some(([supported]) => supported === dataType));
  if (unsupported?.length) throw new Error(`동기화 대상이 아닙니다: ${unsupported.join(', ')}. 재무는 SEC 수집을 사용합니다.`);
  const jobs = requestedDataTypes
    ? allJobs.filter(([dataType]) => requestedDataTypes.includes(dataType))
    : allJobs;
  const result = {};
  for (const [dataType, task] of jobs) {
    try {
      // Massive 일봉은 FMP 키가 없어도 독립적으로 저장한다. 배당은 별도 BQ 큐가 담당한다.
      if (['profile', 'price'].includes(dataType) && !environment.MARKET_DATA_API_KEY) {
        throw new Error('FMP API 키가 없습니다.');
      }
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
export async function syncTickerDataType(environment, ticker, dataType, options = {}) {
  return syncTickerFromFmp(environment, ticker, [dataType], options);
}

/**
 * 장기 이력은 최초 한 번 저장한 뒤, 데이터 성격별 주기에 맞춰서만 덮어쓴다.
 * 이 함수는 FMP 회사·시세와 Massive 우선 일봉만 다룬다. 배당은 별도 BQ 큐에서 갱신한다.
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
