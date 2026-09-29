import { parseBusinessQuantResponse, calculateBusinessQuantMetrics } from './businessquant-metrics.js';
import { syncDividendsFromMassive } from './massive-sync.js';

const BASE_URL = 'https://data.businessquant.com/dividends';
const LIMIT = 24;
const DAY_MS = 86_400_000;
const tickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const utcNow = () => new Date().toISOString();
const utcDay = now => now.slice(0, 10);

function nextFetch(metrics, today) {
  if (metrics.nextExDate) return new Date(Date.parse(`${today}T00:00:00Z`) + 30 * DAY_MS).toISOString();
  if (!metrics.estimatedNextExDate) return new Date(Date.parse(`${today}T00:00:00Z`) + 30 * DAY_MS).toISOString();
  const days = (Date.parse(`${metrics.estimatedNextExDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
  const wait = days <= 7 ? 1 : days <= 14 ? 3 : days <= 30 ? 7 : 30;
  return new Date(Date.now() + wait * DAY_MS).toISOString();
}

/** 키가 로그나 오류에 섞이지 않게 URL과 응답 본문은 기록하지 않는다. */
export async function fetchBusinessQuant(environment, ticker) {
  if (!environment.BUSINESS_QUANT_API_KEY) throw new Error('Business Quant API 키가 없습니다. Worker Secret을 확인해 주세요.');
  const url = new URL(BASE_URL);
  url.searchParams.set('ticker', ticker);
  url.searchParams.set('mode', 'dps');
  url.searchParams.set('api_key', environment.BUSINESS_QUANT_API_KEY);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    const error = new Error(`Business Quant HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return parseBusinessQuantResponse(await response.json(), ticker);
}

/** UTC 하루·최근 24시간 모두 24회 이하로 제한하고, 동일 종목은 같은 UTC일에 한 번만 예약한다. */
export async function reserveBusinessQuantCall(db, ticker, now = utcNow(), limit = LIMIT) {
  const day = utcDay(now);
  const since = new Date(Date.parse(now) - DAY_MS).toISOString();
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Math.min(LIMIT, Number(limit)) : LIMIT;
  const row = await db.prepare(`INSERT INTO bq_api_requests(utc_day, ticker, attempted_at)
    SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM bq_api_pause WHERE utc_day=?)
      AND (SELECT COUNT(*) FROM bq_api_requests WHERE utc_day=?) < ?
      AND (SELECT COUNT(*) FROM bq_api_requests WHERE attempted_at > ?) < ?
    ON CONFLICT(utc_day, ticker) DO NOTHING RETURNING ticker`)
    .bind(day, ticker, now, day, day, safeLimit, since, safeLimit).first();
  return Boolean(row);
}

/** 공급원 누락은 삭제로 해석하지 않는다. 동일 행은 UPDATE도 하지 않는다. */
export function diffBusinessQuantRows(existing, received) {
  const old = new Map(existing.map(row => [row.exDate || row.ex_date, row]));
  const inserted = [], updated = [];
  let unchanged = 0;
  for (const row of received) {
    const before = old.get(row.exDate);
    if (!before) inserted.push(row);
    else if (Number(before.dividend) !== row.dividend
      || (before.paymentDate ?? before.payment_date ?? null) !== row.paymentDate) updated.push(row);
    else unchanged += 1;
  }
  return { inserted, updated, unchanged, existing: existing.length, received: received.length };
}

export async function syncBusinessQuantTicker(environment, ticker, now = utcNow()) {
  if (!tickerPattern.test(ticker)) throw new Error('Business Quant 티커 형식이 올바르지 않습니다.');
  if (!await reserveBusinessQuantCall(environment.DB, ticker, now,
    environment.BUSINESS_QUANT_DAILY_FETCH_LIMIT || LIMIT)) {
    return { ticker, status: 'deferred', reason: '일일/24시간 한도 또는 당일 중복 호출' };
  }
  try {
    const { events, metadata } = await fetchBusinessQuant(environment, ticker);
    const [prior, massive, priorSummary] = await environment.DB.batch([
      environment.DB.prepare(`SELECT ex_date AS exDate, payment_date AS paymentDate, dividend
        FROM bq_dividend_history WHERE ticker=? ORDER BY ex_date`).bind(ticker),
      environment.DB.prepare(`SELECT ex_dividend_date AS exDividendDate,
        distribution_type AS distributionType FROM massive_dividend_events WHERE ticker=?`).bind(ticker),
      environment.DB.prepare(`SELECT massive_dividend_event_detected_at AS massiveDetectedAt,
        last_bq_fetch_at AS lastBqFetchAt FROM bq_dividend_summary WHERE ticker=?`).bind(ticker)
    ]);
    const difference = diffBusinessQuantRows(prior.results, events);
    const today = now.slice(0, 10);
    const summary = calculateBusinessQuantMetrics(events, massive.results, today);
    const statements = [];
    if (difference.inserted.length) statements.push(environment.DB.prepare(`INSERT INTO bq_dividend_history
      (ticker, ex_date, payment_date, dividend, source, first_seen_at, last_seen_at, fetched_at)
      SELECT ?, json_extract(value, '$.exDate'), json_extract(value, '$.paymentDate'),
        json_extract(value, '$.dividend'), 'businessquant', ?, ?, ? FROM json_each(?)`)
      .bind(ticker, now, now, now, JSON.stringify(difference.inserted)));
    if (difference.updated.length) statements.push(environment.DB.prepare(`UPDATE bq_dividend_history
      SET payment_date=(SELECT json_extract(value, '$.paymentDate') FROM json_each(?)
          WHERE json_extract(value, '$.exDate')=bq_dividend_history.ex_date),
        dividend=(SELECT json_extract(value, '$.dividend') FROM json_each(?)
          WHERE json_extract(value, '$.exDate')=bq_dividend_history.ex_date),
        last_seen_at=?, fetched_at=? WHERE ticker=? AND source='businessquant'
          AND ex_date IN (SELECT json_extract(value, '$.exDate') FROM json_each(?))`)
      .bind(JSON.stringify(difference.updated), JSON.stringify(difference.updated), now, now,
        ticker, JSON.stringify(difference.updated)));
    const massiveChanged = priorSummary.results[0]?.massiveDetectedAt
      && (!priorSummary.results[0].lastBqFetchAt
        || priorSummary.results[0].massiveDetectedAt > priorSummary.results[0].lastBqFetchAt);
    const metricsChanged = difference.inserted.length || difference.updated.length || massiveChanged;
    const metricsJson = JSON.stringify(summary);
    // 원본이 그대로면 성장률을 다시 쓰지 않는다. 메타데이터와 다음 확인 시각만 갱신한다.
    statements.push(environment.DB.prepare(`INSERT INTO bq_dividend_summary
      (ticker, history_start, history_end, history_count, ttm_dividend, metadata_divyield,
       metadata_nextdividend, dividend_frequency, paid_dividend_1y, paid_payout_count,
       last_paid_dividend, last_paid_ex_date, last_paid_payment_date, next_dividend,
       next_ex_date, next_payment_date, growth_rate_1y, growth_rate_5y, growth_rate_10y,
       growth_years_available_history, last_bq_fetch_at, next_bq_fetch_at,
       estimated_next_ex_date, confirmed_next_ex_date, fetch_priority, fetch_status,
       last_fetch_error, businessquant_updated_at, special_filter_note)
      SELECT ?, json_extract(?, '$.historyStart'), json_extract(?, '$.historyEnd'),
       json_extract(?, '$.historyCount'), ?, ?, ?, json_extract(?, '$.dividendFrequency'),
       json_extract(?, '$.paidDividend1y'), json_extract(?, '$.paidPayoutCount'),
       json_extract(?, '$.lastPaidDividend'), json_extract(?, '$.lastPaidExDate'),
       json_extract(?, '$.lastPaidPaymentDate'), json_extract(?, '$.nextDividend'),
       json_extract(?, '$.nextExDate'), json_extract(?, '$.nextPaymentDate'),
       json_extract(?, '$.growthRate1y'), json_extract(?, '$.growthRate5y'),
       json_extract(?, '$.growthRate10y'), json_extract(?, '$.growthYearsAvailableHistory'),
       ?, ?, json_extract(?, '$.estimatedNextExDate'), json_extract(?, '$.nextExDate'),
       6, 'ready', NULL, ?, json_extract(?, '$.specialFilterNote')
      ON CONFLICT(ticker) DO UPDATE SET
       history_start=CASE WHEN ? THEN excluded.history_start ELSE history_start END,
       history_end=CASE WHEN ? THEN excluded.history_end ELSE history_end END,
       history_count=CASE WHEN ? THEN excluded.history_count ELSE history_count END,
       dividend_frequency=CASE WHEN ? THEN excluded.dividend_frequency ELSE dividend_frequency END,
       paid_dividend_1y=excluded.paid_dividend_1y,
       paid_payout_count=excluded.paid_payout_count,
       last_paid_dividend=excluded.last_paid_dividend,
       last_paid_ex_date=excluded.last_paid_ex_date,
       last_paid_payment_date=excluded.last_paid_payment_date,
       next_dividend=excluded.next_dividend,
       next_ex_date=excluded.next_ex_date,
       next_payment_date=excluded.next_payment_date,
       growth_rate_1y=CASE WHEN ? THEN excluded.growth_rate_1y ELSE growth_rate_1y END,
       growth_rate_5y=CASE WHEN ? THEN excluded.growth_rate_5y ELSE growth_rate_5y END,
       growth_rate_10y=CASE WHEN ? THEN excluded.growth_rate_10y ELSE growth_rate_10y END,
       growth_years_available_history=CASE WHEN ? THEN excluded.growth_years_available_history ELSE growth_years_available_history END,
       special_filter_note=CASE WHEN ? THEN excluded.special_filter_note ELSE special_filter_note END,
       ttm_dividend=excluded.ttm_dividend, metadata_divyield=excluded.metadata_divyield,
       metadata_nextdividend=excluded.metadata_nextdividend,
       last_bq_fetch_at=excluded.last_bq_fetch_at, next_bq_fetch_at=excluded.next_bq_fetch_at,
       estimated_next_ex_date=excluded.estimated_next_ex_date,
       confirmed_next_ex_date=excluded.confirmed_next_ex_date,
       fetch_priority=6, fetch_status='ready', last_fetch_error=NULL,
       businessquant_updated_at=excluded.businessquant_updated_at`)
      .bind(ticker, ...Array(3).fill(metricsJson), metadata.ttmdividend == null
        ? null : Number.isFinite(Number(metadata.ttmdividend)) ? Number(metadata.ttmdividend) : null,
        Number.isFinite(Number(metadata.divyield)) ? Number(metadata.divyield) : null,
        metadata.nextdividend || null, ...Array(13).fill(metricsJson), now,
        nextFetch(summary, today), metricsJson, metricsJson, now, metricsJson,
        ...Array(9).fill(Number(Boolean(metricsChanged)))));
    await environment.DB.batch(statements);
    await environment.DB.prepare(`UPDATE bq_api_requests SET http_status=200, result_status='ready'
      WHERE utc_day=? AND ticker=?`).bind(utcDay(now), ticker).run();
    return { ticker, status: 'ready', ...difference, ...summary,
      metadataDivyield: metadata.divyield ?? null, ttmDividend: metadata.ttmdividend ?? null };
  } catch (error) {
    const status = error.httpStatus || null;
    const message = String(error.message || error).replaceAll(environment.BUSINESS_QUANT_API_KEY || '\0', '[비공개]').slice(0, 300);
    await environment.DB.prepare(`UPDATE bq_api_requests SET http_status=?, result_status='error'
      WHERE utc_day=? AND ticker=?`).bind(status, utcDay(now), ticker).run();
    if ([401, 403, 429].includes(status)) await environment.DB.prepare(`INSERT INTO bq_api_pause(utc_day, reason, paused_at)
      VALUES (?, ?, ?) ON CONFLICT(utc_day) DO UPDATE SET reason=excluded.reason, paused_at=excluded.paused_at`)
      .bind(utcDay(now), `HTTP ${status}`, now).run();
    await environment.DB.prepare(`INSERT INTO bq_dividend_summary(ticker, fetch_status, last_fetch_error,
      next_bq_fetch_at) VALUES (?, 'error', ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        fetch_status=CASE WHEN bq_dividend_summary.history_count>0 THEN 'ready' ELSE 'error' END,
        last_fetch_error=excluded.last_fetch_error,
        next_bq_fetch_at=excluded.next_bq_fetch_at`)
      .bind(ticker, message, new Date(Date.parse(now) + DAY_MS).toISOString()).run();
    return { ticker, status: 'error', httpStatus: status, error: message };
  }
}

/** 관심목록이 단일 진실 원본이다. DB에 없는 신규 종목은 자동으로 최고 우선순위를 얻는다. */
function allowedTickers(environment) {
  const value = String(environment.DIVIDEND_SYNC_TICKERS || '').trim();
  return value ? value.split(',').map(ticker => ticker.trim().toUpperCase()).filter(ticker => tickerPattern.test(ticker)) : null;
}

export async function nextBusinessQuantTicker(db, now = utcNow(), allowlist = null) {
  return db.prepare(`SELECT w.ticker FROM user_watchlist w
    LEFT JOIN bq_dividend_summary s ON s.ticker=w.ticker
    WHERE w.user_id='primary' AND (s.next_bq_fetch_at IS NULL OR s.next_bq_fetch_at<=?)
      AND (? IS NULL OR w.ticker IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS(SELECT 1 FROM bq_api_requests r WHERE r.utc_day=? AND r.ticker=w.ticker)
    ORDER BY CASE WHEN s.massive_dividend_event_detected_at IS NOT NULL
      AND (s.last_bq_fetch_at IS NULL OR s.massive_dividend_event_detected_at>s.last_bq_fetch_at) THEN 1
      WHEN s.ticker IS NULL OR s.history_count=0 THEN 2
      WHEN s.estimated_next_ex_date BETWEEN ? AND date(?, '+7 days') AND s.next_ex_date IS NULL THEN 3
      WHEN s.estimated_next_ex_date BETWEEN date(?, '+8 days') AND date(?, '+14 days') THEN 4
      WHEN s.last_bq_fetch_at < datetime(?, '-30 days') THEN 5 ELSE 6 END,
      COALESCE(s.next_bq_fetch_at, ''), w.display_order LIMIT 1`)
    .bind(now, allowlist ? JSON.stringify(allowlist) : null,
      allowlist ? JSON.stringify(allowlist) : null, utcDay(now), utcDay(now), utcDay(now),
      utcDay(now), utcDay(now), now).first();
}

export async function runBusinessQuantBatch(environment, now = utcNow()) {
  if (!environment.BUSINESS_QUANT_API_KEY) return { status: 'unconfigured' };
  const ticker = await nextBusinessQuantTicker(environment.DB, now, allowedTickers(environment));
  return ticker ? syncBusinessQuantTicker(environment, ticker.ticker, now) : { status: 'idle' };
}

/** API를 쓰지 않고 지급일 경과·365일 경계와 배당주기별 성장률을 D1 원본으로 다시 계산한다. */
export async function refreshStoredDividendDates(environment, now = utcNow()) {
  const today = utcDay(now);
  const due = await environment.DB.prepare(`SELECT s.ticker FROM bq_dividend_summary s
    JOIN user_watchlist w ON w.ticker=s.ticker AND w.user_id='primary'
    WHERE s.fetch_status='ready' AND substr(COALESCE(s.businessquant_updated_at, ''),1,10) < ?
      AND (? IS NULL OR s.ticker IN (SELECT value FROM json_each(?)))
    ORDER BY s.businessquant_updated_at LIMIT 2`)
    .bind(today, allowedTickers(environment) ? JSON.stringify(allowedTickers(environment)) : null,
      allowedTickers(environment) ? JSON.stringify(allowedTickers(environment)) : null).all();
  for (const { ticker } of due.results) {
    const [history, massive] = await environment.DB.batch([
      environment.DB.prepare(`SELECT ex_date AS exDate, payment_date AS paymentDate, dividend
        FROM bq_dividend_history WHERE ticker=? ORDER BY ex_date`).bind(ticker),
      environment.DB.prepare(`SELECT ex_dividend_date AS exDividendDate,
        distribution_type AS distributionType FROM massive_dividend_events WHERE ticker=?`).bind(ticker)
    ]);
    if (!history.results.length) continue;
    const metrics = calculateBusinessQuantMetrics(history.results, massive.results, today);
    await environment.DB.prepare(`UPDATE bq_dividend_summary SET dividend_frequency=?,
      paid_dividend_1y=?, paid_payout_count=?,
      last_paid_dividend=?, last_paid_ex_date=?, last_paid_payment_date=?, next_dividend=?,
      next_ex_date=?, next_payment_date=?, confirmed_next_ex_date=?,
      growth_rate_1y=?, growth_rate_5y=?, growth_rate_10y=?,
      growth_years_available_history=?, special_filter_note=?,
      businessquant_updated_at=? WHERE ticker=?`)
      .bind(metrics.dividendFrequency, metrics.paidDividend1y, metrics.paidPayoutCount,
        metrics.lastPaidDividend,
        metrics.lastPaidExDate, metrics.lastPaidPaymentDate, metrics.nextDividend,
        metrics.nextExDate, metrics.nextPaymentDate, metrics.nextExDate,
        metrics.growthRate1y, metrics.growthRate5y, metrics.growthRate10y,
        metrics.growthYearsAvailableHistory, metrics.specialFilterNote, now, ticker).run();
  }
  return { refreshed: due.results.length };
}

/** Massive의 새 선언을 감지하면 BQ 재수집 시각을 당기되, 상세 페이지에서는 호출하지 않는다. */
export async function runMassiveDividendCheck(environment, now = utcNow()) {
  if (!environment.MASSIVE_API_KEY) return { status: 'unconfigured' };
  const target = await environment.DB.prepare(`SELECT w.ticker FROM user_watchlist w
    LEFT JOIN massive_dividend_checks c ON c.ticker=w.ticker
    LEFT JOIN bq_dividend_summary s ON s.ticker=w.ticker
    WHERE w.user_id='primary' AND (c.next_check_at IS NULL OR c.next_check_at<=?)
      AND (? IS NULL OR w.ticker IN (SELECT value FROM json_each(?)))
    ORDER BY CASE WHEN s.estimated_next_ex_date BETWEEN ? AND date(?, '+30 days') THEN 0 ELSE 1 END,
      COALESCE(c.next_check_at, ''), w.display_order LIMIT 1`)
    .bind(now, allowedTickers(environment) ? JSON.stringify(allowedTickers(environment)) : null,
      allowedTickers(environment) ? JSON.stringify(allowedTickers(environment)) : null,
      utcDay(now), utcDay(now)).first();
  if (!target) return { status: 'idle' };
  const ticker = target.ticker;
  try {
    const result = await syncDividendsFromMassive(environment, ticker);
    const interval = result.newDeclarations ? DAY_MS : 3 * DAY_MS;
    await environment.DB.prepare(`INSERT INTO massive_dividend_checks(ticker, last_checked_at, next_check_at)
      VALUES (?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET last_checked_at=excluded.last_checked_at,
        next_check_at=excluded.next_check_at, last_error=NULL`)
      .bind(ticker, now, new Date(Date.parse(now) + interval).toISOString()).run();
    if (result.newDeclarations) await environment.DB.prepare(`INSERT INTO bq_dividend_summary
      (ticker, fetch_priority, fetch_status, massive_dividend_event_detected_at, next_bq_fetch_at)
      VALUES (?, 1, 'pending', ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET fetch_priority=1,
        massive_dividend_event_detected_at=excluded.massive_dividend_event_detected_at,
        next_bq_fetch_at=excluded.next_bq_fetch_at`)
      .bind(ticker, now, now).run();
    return { ticker, status: 'ready', ...result };
  } catch (error) {
    const message = String(error.message || error).slice(0, 300);
    await environment.DB.prepare(`INSERT INTO massive_dividend_checks
      (ticker, last_checked_at, next_check_at, last_error) VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET last_checked_at=excluded.last_checked_at,
        next_check_at=excluded.next_check_at, last_error=excluded.last_error`)
      .bind(ticker, now, new Date(Date.parse(now) + DAY_MS).toISOString(), message).run();
    return { ticker, status: 'error', error: message };
  }
}

export async function runDividendPipeline(environment, now = utcNow()) {
  if (environment.DIVIDEND_PIPELINE_ENABLED !== 'true') return { status: 'disabled' };
  const localRefresh = await refreshStoredDividendDates(environment, now);
  const massive = await runMassiveDividendCheck(environment, now);
  const businessQuant = await runBusinessQuantBatch(environment, now);
  return { localRefresh, massive, businessQuant };
}
