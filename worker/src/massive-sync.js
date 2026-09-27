import { refreshWilliamsSignal } from './williams-store.js';

const BASE_URL = 'https://api.massive.com';
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoDate(value) {
  const text = String(value || '').slice(0, 10);
  return DATE_PATTERN.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function dayBefore(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** 무료 Basic의 분당 5회 상한을 Worker 인스턴스가 달라도 D1에서 원자적으로 공유한다. */
async function reserveCall(environment) {
  const minute = new Date().toISOString().slice(0, 16);
  const result = await environment.DB.prepare(`INSERT INTO massive_api_budget(minute, calls) VALUES (?, 1)
    ON CONFLICT(minute) DO UPDATE SET calls=calls+1 WHERE calls < 5 RETURNING calls`).bind(minute).first();
  if (!result) throw new Error('Massive 분당 5회 요청 한도: 다음 수집 주기에 재시도합니다.');
}

async function getJson(environment, url) {
  if (!environment.MASSIVE_API_KEY) throw new Error('Massive API 키가 없습니다. Worker Secret MASSIVE_API_KEY를 설정해 주세요.');
  const target = new URL(url, BASE_URL);
  // next_url은 외부 응답이므로 공급자 호스트·HTTPS를 검사해 Secret이 다른 서버로 전송되지 않게 한다.
  if (target.origin !== BASE_URL) throw new Error('Massive 페이지 주소가 올바르지 않습니다.');
  await reserveCall(environment);
  const response = await fetch(target, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${environment.MASSIVE_API_KEY}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Massive 요청 실패: HTTP ${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.results)) {
    if (body?.status === 'OK' && (body?.resultsCount === 0 || body?.count === 0)) {
      return { ...body, results: [] };
    }
    throw new Error('Massive 응답 형식을 확인할 수 없습니다. 기존 저장값을 유지합니다.');
  }
  return body;
}

/** FMP 일봉에 실패했을 때만 100일 범위를 조회하고 유효한 OHLCV만 저장한다. */
export async function syncCandlesFromMassive(environment, ticker) {
  if (!TICKER_PATTERN.test(ticker)) throw new Error('Massive 일봉 조회 티커가 올바르지 않습니다.');
  const url = new URL(`${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${dayBefore(100)}/${dayBefore(0)}`);
  url.searchParams.set('adjusted', 'true');
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('limit', '500');
  const payload = await getJson(environment, url);
  const rows = payload.results.map(row => ({
    date: Number.isFinite(Number(row.t)) ? new Date(Number(row.t)).toISOString().slice(0, 10) : null,
    open: finiteNumber(row.o), high: finiteNumber(row.h), low: finiteNumber(row.l),
    close: finiteNumber(row.c), volume: finiteNumber(row.v)
  })).filter(row => row.date && [row.open, row.high, row.low, row.close].every(value => value !== null));
  if (!rows.length) throw new Error('Massive에서 저장 가능한 3개월 일봉을 받지 못했습니다.');
  await environment.DB.batch(rows.map(row => environment.DB.prepare(`INSERT INTO price_candles
    (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MASSIVE', CURRENT_TIMESTAMP)
    ON CONFLICT(ticker, candle_date) DO UPDATE SET open_price=excluded.open_price,
      high_price=excluded.high_price, low_price=excluded.low_price, close_price=excluded.close_price,
      adjusted_close=excluded.adjusted_close, volume=excluded.volume, source=excluded.source,
      cached_at=CURRENT_TIMESTAMP`).bind(ticker, row.date, row.open, row.high, row.low,
    row.close, row.close, row.volume)));
  await refreshWilliamsSignal(environment, ticker);
  return { source: 'MASSIVE', count: rows.length };
}

/** 모든 페이지를 받은 뒤에만 해당 종목의 Massive 캐시를 교체한다. 빈 응답은 무배당 종목으로 취급한다. */
export async function syncDividendsFromMassive(environment, ticker) {
  if (!TICKER_PATTERN.test(ticker)) throw new Error('Massive 배당 조회 티커가 올바르지 않습니다.');
  const url = new URL(`${BASE_URL}/stocks/v1/dividends`);
  url.searchParams.set('ticker', ticker);
  url.searchParams.set('sort', 'ex_dividend_date.desc');
  url.searchParams.set('limit', '1000');
  const events = [];
  let nextUrl = url.toString();
  for (let page = 0; nextUrl && page < 5; page += 1) {
    const target = new URL(nextUrl);
    if (target.origin !== BASE_URL || target.pathname !== '/stocks/v1/dividends') {
      throw new Error('Massive 배당 페이지 주소가 올바르지 않습니다.');
    }
    const payload = await getJson(environment, target);
    events.push(...payload.results);
    nextUrl = payload.next_url || null;
  }
  if (nextUrl) throw new Error('Massive 배당 이력이 5페이지를 넘어 이번에는 저장하지 않았습니다.');
  const normalized = events.map(row => ({
    id: row.id ? String(row.id) : null,
    exDate: isoDate(row.ex_dividend_date), declarationDate: isoDate(row.declaration_date),
    recordDate: isoDate(row.record_date), paymentDate: isoDate(row.pay_date),
    amount: finiteNumber(row.cash_amount), adjustedAmount: finiteNumber(row.split_adjusted_cash_amount),
    distributionType: ['recurring', 'special', 'supplemental', 'irregular', 'unknown'].includes(row.distribution_type)
      ? row.distribution_type : 'unknown',
    frequency: row.frequency !== null && row.frequency !== undefined
      && Number.isInteger(Number(row.frequency)) ? Number(row.frequency) : null
  })).filter(row => row.exDate && row.amount !== null && row.amount > 0);
  const unique = new Map(normalized.map(row => [row.id
    || `${row.exDate}:${row.recordDate}:${row.paymentDate}:${row.amount}:${row.distributionType}`, row]));
  // 두 문장을 한 트랜잭션에서 실행해 중간 실패 시 기존 이벤트가 지워지지 않게 한다.
  await environment.DB.batch([
    environment.DB.prepare('DELETE FROM massive_dividend_events WHERE ticker=?').bind(ticker),
    environment.DB.prepare(`INSERT INTO massive_dividend_events
      (ticker, provider_event_id, declaration_date, ex_dividend_date, record_date, payment_date,
        amount, split_adjusted_amount, distribution_type, frequency, source_updated_at)
      SELECT ?, key, json_extract(value, '$.declarationDate'), json_extract(value, '$.exDate'),
        json_extract(value, '$.recordDate'), json_extract(value, '$.paymentDate'),
        json_extract(value, '$.amount'), json_extract(value, '$.adjustedAmount'),
        json_extract(value, '$.distributionType'), json_extract(value, '$.frequency'), CURRENT_TIMESTAMP
      FROM json_each(?)`).bind(ticker, JSON.stringify(Object.fromEntries(unique)))
  ]);
  return { source: 'MASSIVE', count: unique.size };
}
