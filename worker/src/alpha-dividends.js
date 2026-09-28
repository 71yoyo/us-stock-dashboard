const API_URL = 'https://www.alphavantage.co/query';
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** API의 당시 주당 지급액은 분할 이전 주식 수 기준이다. 이후 분할 비율을 모두 적용해 현재 1주 기준으로 환산한다. */
export function normalizeAlphaDividendHistory(dividendPayload, splitPayload, ticker) {
  if (!Array.isArray(dividendPayload?.data) || !Array.isArray(splitPayload?.data)) {
    throw new Error('Alpha Vantage 배당·분할 응답 형식을 확인할 수 없습니다. 기존 Alpha 저장값을 유지합니다.');
  }
  if (dividendPayload.symbol && dividendPayload.symbol.toUpperCase() !== ticker) {
    throw new Error('Alpha Vantage 배당 응답의 종목이 요청 종목과 다릅니다.');
  }
  const splits = splitPayload.data.map(row => ({
    date: dateOrNull(row.effective_date), factor: positiveNumber(row.split_factor)
  }));
  if (splits.some(row => !row.date || !row.factor)) {
    throw new Error('Alpha Vantage 주식분할 이력에 올바르지 않은 값이 있습니다.');
  }
  let skippedZeroCount = 0;
  const skippedZeroYears = new Set();
  const events = dividendPayload.data.map(row => {
    const exDividendDate = dateOrNull(row.ex_dividend_date);
    const amount = positiveNumber(row.amount);
    if (!exDividendDate) throw new Error('Alpha Vantage 배당 이력에 올바르지 않은 날짜가 있습니다.');
    if (Number(row.amount) === 0) {
      // NVDA 실제 응답처럼 0.0으로 제공된 행은 지급액을 확정할 수 없어 합계에서 제외한다.
      skippedZeroCount += 1;
      skippedZeroYears.add(Number(exDividendDate.slice(0, 4)));
      return null;
    }
    if (!amount) throw new Error('Alpha Vantage 배당 이력에 올바르지 않은 금액이 있습니다.');
    const factor = splits.filter(split => split.date > exDividendDate)
      .reduce((product, split) => product * split.factor, 1);
    const declarationDate = dateOrNull(row.declaration_date);
    const recordDate = dateOrNull(row.record_date);
    const paymentDate = dateOrNull(row.payment_date);
    return {
      exDividendDate, declarationDate, recordDate, paymentDate, amount,
      adjustedAmount: amount / factor, source: 'ALPHA_VANTAGE',
      eventKey: [exDividendDate, declarationDate || '', recordDate || '', paymentDate || '', amount].join('|')
    };
  }).filter(Boolean).sort((left, right) => left.exDividendDate.localeCompare(right.exDividendDate));
  if (new Set(events.map(row => row.eventKey)).size !== events.length) {
    throw new Error('Alpha Vantage 배당 이력에 중복 이벤트가 있습니다. 기존 Alpha 저장값을 유지합니다.');
  }
  return { events, splitCount: splits.length, skippedZeroCount,
    skippedZeroYears: [...skippedZeroYears] };
}

/** 진행 중인 연도는 제외하고 완료된 역년의 분할 조정 주당 배당금으로 1·5·10년 성장률을 구한다. */
export function summarizeAlphaDividendHistory(events, today = new Date().toISOString().slice(0, 10),
  skippedZeroYears = []) {
  const latestYear = Number(today.slice(0, 4)) - 1;
  const incompleteYears = new Set(skippedZeroYears);
  const annual = new Map();
  for (const row of events) {
    const year = Number(row.exDividendDate?.slice(0, 4));
    if (year > latestYear || !Number.isFinite(row.adjustedAmount)) continue;
    annual.set(year, (annual.get(year) || 0) + row.adjustedAmount);
  }
  const earliestDate = events[0]?.exDividendDate || null;
  const current = annual.get(latestYear) || null;
  const growthForYears = years => {
    const baselineYear = latestYear - years;
    const baseline = annual.get(baselineYear);
    // 비교 연도의 1월부터 이력이 확보되지 않았다면 부분 연도를 완전한 연도로 간주하지 않는다.
    if (!current || !baseline || !earliestDate || earliestDate > `${baselineYear}-01-01`
      || incompleteYears.has(latestYear) || incompleteYears.has(baselineYear)) return null;
    return (Math.pow(current / baseline, 1 / years) - 1) * 100;
  };
  let growthYears = 0;
  for (let year = latestYear; year > 1900; year -= 1) {
    if (!annual.get(year - 1) || !annual.get(year) || !earliestDate
      || earliestDate > `${year - 1}-01-01` || incompleteYears.has(year)
      || incompleteYears.has(year - 1) || annual.get(year) <= annual.get(year - 1)) break;
    growthYears += 1;
  }
  return {
    source: 'ALPHA_VANTAGE', annualPeriodEnd: `${latestYear}-12-31`,
    annualDividend: incompleteYears.has(latestYear) ? null : current,
    skippedZeroCount: skippedZeroYears.length, dividendGrowthYears: growthYears,
    dividendGrowth1y: growthForYears(1),
    dividendGrowthCagr5y: growthForYears(5),
    dividendGrowthCagr10y: growthForYears(10)
  };
}

async function reserveAlphaCall(environment) {
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const now = new Date();
    const reserved = await environment.DB.prepare(`INSERT INTO alpha_api_throttle(name, next_allowed_at)
      VALUES ('global', ?)
      ON CONFLICT(name) DO UPDATE SET next_allowed_at=excluded.next_allowed_at
      WHERE alpha_api_throttle.next_allowed_at <= ? RETURNING name`)
      // 공급원의 초당 1회 제한은 네트워크 지연·서버 시계 차이를 고려해 3초 간격으로 지킨다.
      .bind(new Date(now.getTime() + 3000).toISOString(), now.toISOString()).first();
    if (reserved) break;
    if (attempt === 34) throw new Error('Alpha Vantage 초당 호출 간격 대기 초과: 잠시 후 다시 시도합니다.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const day = new Date().toISOString().slice(0, 10);
  const reserved = await environment.DB.prepare(`INSERT INTO alpha_api_budget(day, calls) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls < 25 RETURNING calls`).bind(day).first();
  if (!reserved) throw new Error('Alpha Vantage 무료 호출 25회/일 예산 소진: 다음날 다시 확인합니다.');
}

async function fetchAlphaData(environment, ticker, functionName) {
  await reserveAlphaCall(environment);
  const url = new URL(API_URL);
  url.searchParams.set('function', functionName);
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('apikey', environment.ALPHA_VANTAGE_API_KEY);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error(`Alpha Vantage ${functionName} 연결 실패: 잠시 후 다시 시도합니다.`);
  }
  if (!response.ok) throw new Error(`Alpha Vantage ${functionName} HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`Alpha Vantage ${functionName} JSON 응답을 읽지 못했습니다.`); }
  if (payload?.Information || payload?.Note) {
    // 원문에서 키와 링크를 제거한 짧은 진단만 운영 로그에 남겨 제한·권한 오류를 구분한다.
    const safeNotice = String(payload.Information || payload.Note)
      .replaceAll(environment.ALPHA_VANTAGE_API_KEY, '[비공개]')
      .replace(/https?:\/\/\S+/g, '[링크]').slice(0, 350);
    console.warn(`Alpha Vantage ${functionName} 안내 (${ticker}): ${safeNotice}`);
    const notice = safeNotice.toLowerCase();
    if (/1 request per second|per-second|spreading out|burst limit/.test(notice)) {
      throw new Error('Alpha Vantage 초당 호출 제한: 15분 후 다시 확인합니다.');
    }
    throw new Error('Alpha Vantage 일일 호출 제한 또는 권한 안내를 받았습니다. 다음날 다시 확인합니다.');
  }
  if (payload?.['Error Message'] || !Array.isArray(payload?.data)) {
    throw new Error(`Alpha Vantage ${functionName} 이력을 받지 못했습니다. 종목·권한을 확인해 주세요.`);
  }
  return payload;
}

/** 두 endpoint가 모두 성공한 뒤에만 Alpha 원본을 교체한다. 실패하면 이전 정상 Alpha 이력을 유지한다. */
export async function syncAlphaDividends(environment, ticker) {
  if (!TICKER_PATTERN.test(ticker)) throw new Error('Alpha Vantage 배당 조회 티커가 올바르지 않습니다.');
  if (!environment.ALPHA_VANTAGE_API_KEY) throw new Error('Alpha Vantage API 키가 없습니다. 로컬 설정 또는 Worker Secret을 확인해 주세요.');
  const dividends = await fetchAlphaData(environment, ticker, 'DIVIDENDS');
  const splits = await fetchAlphaData(environment, ticker, 'SPLITS');
  const normalized = normalizeAlphaDividendHistory(dividends, splits, ticker);
  const metrics = summarizeAlphaDividendHistory(normalized.events,
    new Date().toISOString().slice(0, 10), normalized.skippedZeroYears);
  const now = new Date().toISOString();
  await environment.DB.batch([
    environment.DB.prepare('DELETE FROM alpha_dividend_events WHERE ticker=?').bind(ticker),
    environment.DB.prepare(`INSERT INTO alpha_dividend_events
      (ticker, event_key, declaration_date, ex_dividend_date, record_date, payment_date, amount, split_adjusted_amount)
      SELECT ?, json_extract(value, '$.eventKey'), json_extract(value, '$.declarationDate'),
        json_extract(value, '$.exDividendDate'), json_extract(value, '$.recordDate'),
        json_extract(value, '$.paymentDate'), json_extract(value, '$.amount'),
        json_extract(value, '$.adjustedAmount') FROM json_each(?)`)
      .bind(ticker, JSON.stringify(normalized.events)),
    environment.DB.prepare(`INSERT INTO alpha_dividend_sync
      (ticker, status, event_count, split_count, metrics_json, last_success_at, last_attempt_at, next_retry_at, last_error)
      VALUES (?, 'ready', ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(ticker) DO UPDATE SET status='ready', event_count=excluded.event_count,
        split_count=excluded.split_count, metrics_json=excluded.metrics_json,
        last_success_at=excluded.last_success_at, last_attempt_at=excluded.last_attempt_at,
        next_retry_at=NULL, last_error=NULL`)
      .bind(ticker, normalized.events.length, normalized.splitCount, JSON.stringify(metrics), now, now)
  ]);
  return { source: 'ALPHA_VANTAGE', eventCount: normalized.events.length,
    splitCount: normalized.splitCount, skippedZeroCount: normalized.skippedZeroCount,
    oldestExDate: normalized.events[0]?.exDividendDate || null,
    latestExDate: normalized.events.at(-1)?.exDividendDate || null,
    growthBaselineYear: Number(metrics.annualPeriodEnd.slice(0, 4)),
    growthAvailable: [metrics.dividendGrowth1y, metrics.dividendGrowthCagr5y,
      metrics.dividendGrowthCagr10y].map(value => value !== null) };
}
