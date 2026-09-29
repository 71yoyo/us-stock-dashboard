import { refreshWilliamsSignal, refreshWilliamsSignals } from './williams-store.js';

const BASE_URL = 'https://api.massive.com';
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 공급원 데이터가 없거나 불완전할 때만 FMP 보조 경로를 열기 위한 오류 구분이다. */
export class MassiveCandleUnavailableError extends Error {}
/** 장은 끝났지만 해당 거래일 일봉이 아직 공개되지 않은 상태다. FMP 오류로 오인해 우회하지 않는다. */
export class MassiveCandlePendingError extends Error {}

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

/** 공급자 응답에서 완전한 일봉만 골라, 저장 전 원본 형식과 가격 범위를 검증한다. */
function normalizeCandle(row) {
  const timestamp = Number(row?.t);
  const dateValue = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null;
  const date = dateValue && Number.isFinite(dateValue.getTime()) ? dateValue.toISOString().slice(0, 10) : null;
  const open = finiteNumber(row?.o);
  const high = finiteNumber(row?.h);
  const low = finiteNumber(row?.l);
  const close = finiteNumber(row?.c);
  const volume = finiteNumber(row?.v);
  if (!date || [open, high, low, close, volume].some(value => value === null)
    || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close)
    || open <= 0 || close <= 0 || volume < 0) return null;
  return { date, open, high, low, close, volume };
}

function candleUpsert(environment, ticker, rows) {
  return environment.DB.prepare(`INSERT INTO price_candles
    (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source, cached_at)
    SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.open'),
      json_extract(value, '$.high'), json_extract(value, '$.low'), json_extract(value, '$.close'),
      json_extract(value, '$.close'), json_extract(value, '$.volume'), 'MASSIVE', CURRENT_TIMESTAMP
    FROM json_each(?) WHERE 1
    ON CONFLICT(ticker, candle_date) DO UPDATE SET open_price=excluded.open_price,
      high_price=excluded.high_price, low_price=excluded.low_price, close_price=excluded.close_price,
      adjusted_close=excluded.adjusted_close, volume=excluded.volume, source=excluded.source,
      cached_at=CURRENT_TIMESTAMP`).bind(ticker, JSON.stringify(rows));
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

/** 신규·기존 종목의 3개월치를 Massive에서 먼저 확인한 뒤, FMP 혼합 구간을 한 번에 교체한다. */
export async function syncCandlesFromMassive(environment, ticker, minimumDate = null) {
  if (!TICKER_PATTERN.test(ticker)) throw new Error('Massive 일봉 조회 티커가 올바르지 않습니다.');
  const fromDate = dayBefore(100);
  const url = new URL(`${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fromDate}/${dayBefore(0)}`);
  url.searchParams.set('adjusted', 'true');
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('limit', '500');
  let payload;
  try { payload = await getJson(environment, url); }
  catch (error) {
    if (/Massive 분당 5회 요청 한도/.test(String(error))) throw error;
    throw new MassiveCandleUnavailableError(String(error.message || error));
  }
  if (payload.adjusted === false) throw new MassiveCandleUnavailableError('Massive 분할 조정 일봉이 아닙니다.');
  const rows = [...new Map(payload.results.map(normalizeCandle).filter(Boolean)
    .map(row => [row.date, row])).values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!rows.length) throw new MassiveCandleUnavailableError('Massive에서 저장 가능한 3개월 일봉을 받지 못했습니다.');
  const previous = await environment.DB.prepare(`SELECT COUNT(*) AS count, MAX(candle_date) AS latestDate
    FROM price_candles WHERE ticker=? AND source='FMP' AND candle_date>=?`).bind(ticker, fromDate).first();
  const latestMassiveDate = rows.at(-1)?.date;
  // 기존에 충분한 FMP 이력이 있으면 지나치게 짧거나 오래된 Massive 응답으로 덮지 않는다.
  if (Number(previous?.count) >= 20 && rows.length < Math.ceil(Number(previous.count) * 0.8)) {
    throw new MassiveCandleUnavailableError('Massive 일봉 범위가 기존 저장 이력보다 짧아 기존 값을 유지합니다.');
  }
  if (previous?.latestDate && previous.latestDate > latestMassiveDate) {
    throw new MassiveCandleUnavailableError('Massive 최신 일봉 날짜가 기존 저장값보다 오래되어 기존 값을 유지합니다.');
  }
  // 장 마감 확인 작업에서 이전 거래일만 돌아오면 기존 일봉을 다시 쓰지 않고 15분 뒤 확인한다.
  if (minimumDate && latestMassiveDate < minimumDate) {
    throw new MassiveCandlePendingError(`${minimumDate} Massive 일봉 공개 대기 · 최근 제공 ${latestMassiveDate}`);
  }
  await environment.DB.batch([
    // 마이그레이션 이후 추가된 FMP 보조 일봉까지 복구용으로 남기고, 검증 성공 후에만 활성 값을 교체한다.
    environment.DB.prepare(`INSERT OR IGNORE INTO archived_fmp_candles
      (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, cached_at)
      SELECT ticker, candle_date, open_price, high_price, low_price, close_price,
        adjusted_close, volume, cached_at FROM price_candles WHERE ticker=? AND source='FMP'`).bind(ticker),
    environment.DB.prepare("DELETE FROM price_candles WHERE ticker=? AND source='FMP'").bind(ticker),
    candleUpsert(environment, ticker, rows)
  ]);
  await refreshWilliamsSignal(environment, ticker);
  await environment.DB.prepare(`INSERT INTO massive_candle_backfills(ticker, completed_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET completed_at=CURRENT_TIMESTAMP`).bind(ticker).run();
  return { source: 'MASSIVE', count: rows.length };
}

/** 전체 시장 한 날짜를 한 번 조회하되, 이미 3개월 적재를 마친 관심종목만 추려 저장한다. */
export async function syncGroupedCandlesFromMassive(environment, marketDate, eligibleTickers) {
  if (!isoDate(marketDate) || !eligibleTickers?.length) throw new Error('전체 시장 일봉 날짜 또는 대상 종목이 없습니다.');
  const tickerSet = new Set(eligibleTickers.filter(ticker => TICKER_PATTERN.test(ticker)));
  if (!tickerSet.size) throw new Error('전체 시장 일봉에 저장할 유효한 종목이 없습니다.');
  const url = new URL(`${BASE_URL}/v2/aggs/grouped/locale/us/market/stocks/${marketDate}`);
  url.searchParams.set('adjusted', 'true');
  const payload = await getJson(environment, url);
  if (payload.adjusted === false) throw new Error('Massive 전체 시장 일봉의 분할 조정 상태를 확인해 주세요.');
  const matched = payload.results.flatMap(row => {
    if (!tickerSet.has(row.T)) return [];
    const candle = normalizeCandle(row);
    return candle?.date === marketDate ? [{ ticker: row.T, ...candle }] : [];
  });
  if (!matched.length) throw new Error(`${marketDate} 전체 시장 일봉이 아직 제공되지 않았습니다. 기존 값을 유지합니다.`);
  // 한 번의 SQL로 관심종목만 쓰므로 무료 Worker의 호출당 D1 쿼리 한도를 넘지 않는다.
  await environment.DB.prepare(`INSERT INTO price_candles
    (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source, cached_at)
    SELECT json_extract(value, '$.ticker'), json_extract(value, '$.date'),
      json_extract(value, '$.open'), json_extract(value, '$.high'), json_extract(value, '$.low'),
      json_extract(value, '$.close'), json_extract(value, '$.close'),
      json_extract(value, '$.volume'), 'MASSIVE', CURRENT_TIMESTAMP
    FROM json_each(?) WHERE 1
    ON CONFLICT(ticker, candle_date) DO UPDATE SET open_price=excluded.open_price,
      high_price=excluded.high_price, low_price=excluded.low_price, close_price=excluded.close_price,
      adjusted_close=excluded.adjusted_close, volume=excluded.volume, source=excluded.source,
      cached_at=CURRENT_TIMESTAMP`).bind(JSON.stringify(matched)).run();
  const updatedTickers = [...new Set(matched.map(row => row.ticker))];
  await refreshWilliamsSignals(environment, updatedTickers);
  const now = new Date().toISOString();
  await environment.DB.prepare(`UPDATE data_sync_state SET last_success_at=?, last_attempt_at=?,
    next_retry_at=NULL, failure_count=0, last_error=NULL
    WHERE data_type='candles' AND last_success_at IS NOT NULL
      AND ticker IN (SELECT value FROM json_each(?))`).bind(now, now, JSON.stringify(updatedTickers)).run();
  return { source: 'MASSIVE', marketDate, count: updatedTickers.length,
    missing: [...tickerSet].filter(ticker => !updatedTickers.includes(ticker)) };
}

/** 모든 페이지를 검증한 뒤 변경 이벤트만 갱신한다. 응답 누락으로 과거 원본을 지우지 않는다. */
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
  const prior = await environment.DB.prepare(`SELECT provider_event_id AS id,
    declaration_date AS declarationDate, ex_dividend_date AS exDate,
    payment_date AS paymentDate, amount, distribution_type AS distributionType
    FROM massive_dividend_events WHERE ticker=?`).bind(ticker).all();
  const existing = new Map(prior.results.map(row => [row.id, row]));
  const changed = [...unique].filter(([id, row]) => {
    const before = existing.get(id);
    return !before || before.declarationDate !== row.declarationDate || before.exDate !== row.exDate
      || before.paymentDate !== row.paymentDate || Number(before.amount) !== row.amount
      || before.distributionType !== row.distributionType;
  });
  if (changed.length) await environment.DB.prepare(`INSERT INTO massive_dividend_events
      (ticker, provider_event_id, declaration_date, ex_dividend_date, record_date, payment_date,
        amount, split_adjusted_amount, distribution_type, frequency, source_updated_at)
      SELECT ?, key, json_extract(value, '$.declarationDate'), json_extract(value, '$.exDate'),
        json_extract(value, '$.recordDate'), json_extract(value, '$.paymentDate'),
        json_extract(value, '$.amount'), json_extract(value, '$.adjustedAmount'),
        json_extract(value, '$.distributionType'), json_extract(value, '$.frequency'), CURRENT_TIMESTAMP
      FROM json_each(?) WHERE 1 ON CONFLICT(ticker, provider_event_id) DO UPDATE SET
        declaration_date=excluded.declaration_date, ex_dividend_date=excluded.ex_dividend_date,
        record_date=excluded.record_date, payment_date=excluded.payment_date,
        amount=excluded.amount, split_adjusted_amount=excluded.split_adjusted_amount,
        distribution_type=excluded.distribution_type, frequency=excluded.frequency,
        source_updated_at=excluded.source_updated_at`)
    .bind(ticker, JSON.stringify(Object.fromEntries(changed))).run();
  const today = new Date().toISOString().slice(0, 10);
  const newDeclarations = changed.filter(([id, row]) => row.exDate >= today
    && row.declarationDate && (!existing.has(id)
      || existing.get(id).declarationDate !== row.declarationDate));
  return { source: 'MASSIVE', count: unique.size, changed: changed.length,
    newDeclarations: newDeclarations.length };
}
