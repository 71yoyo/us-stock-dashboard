import '../../williams-signal.js';

/** 최신 30개 일봉으로 현재 구간과 전일 대비 방향을 계산해 모든 기기에 같은 상태를 제공한다. */
export async function refreshWilliamsSignal(environment, ticker) {
  await environment.DB.prepare(`CREATE TABLE IF NOT EXISTS williams_signals (
    ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
    last_candle_date TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();

  const result = await environment.DB.prepare(`SELECT candle_date AS time, high_price AS high,
    low_price AS low, close_price AS close
    FROM price_candles WHERE ticker = ? ORDER BY candle_date DESC LIMIT 30`).bind(ticker).all();
  const summary = globalThis.WilliamsSignalEngine.summarize(result.results.reverse());
  if (!summary) return null;

  await environment.DB.prepare(`INSERT INTO williams_signals
    (ticker, last_candle_date, summary_json, calculated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET last_candle_date=excluded.last_candle_date,
      summary_json=excluded.summary_json, calculated_at=CURRENT_TIMESTAMP`)
    .bind(ticker, summary.lastCandleDate, JSON.stringify(summary)).run();
  return summary;
}

/** 전체 시장 일봉을 저장한 뒤에는 종목별 DB 왕복 대신 최근 30봉을 한꺼번에 읽어 신호를 갱신한다. */
export async function refreshWilliamsSignals(environment, tickers) {
  const uniqueTickers = [...new Set(tickers)];
  if (!uniqueTickers.length) return 0;
  let updated = 0;
  // D1의 한 SQL당 바인딩 100개 제한을 넘지 않도록 목록을 나눈다.
  for (let offset = 0; offset < uniqueTickers.length; offset += 80) {
    const group = uniqueTickers.slice(offset, offset + 80);
    const placeholders = group.map(() => '?').join(', ');
    const result = await environment.DB.prepare(`SELECT ticker, candle_date AS time,
      high_price AS high, low_price AS low, close_price AS close FROM (
        SELECT ticker, candle_date, high_price, low_price, close_price,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY candle_date DESC) AS candle_rank
        FROM price_candles WHERE ticker IN (${placeholders})
      ) WHERE candle_rank <= 30 ORDER BY ticker, time`).bind(...group).all();
    const candlesByTicker = new Map();
    for (const row of result.results) {
      const candles = candlesByTicker.get(row.ticker) || [];
      candles.push(row);
      candlesByTicker.set(row.ticker, candles);
    }
    const summaries = [...candlesByTicker].flatMap(([ticker, candles]) => {
      const summary = globalThis.WilliamsSignalEngine.summarize(candles);
      return summary ? [{ ticker, date: summary.lastCandleDate, summary: JSON.stringify(summary) }] : [];
    });
    if (!summaries.length) continue;
    await environment.DB.prepare(`INSERT INTO williams_signals
      (ticker, last_candle_date, summary_json, calculated_at)
      SELECT json_extract(value, '$.ticker'), json_extract(value, '$.date'),
        json_extract(value, '$.summary'), CURRENT_TIMESTAMP FROM json_each(?) WHERE 1
      ON CONFLICT(ticker) DO UPDATE SET last_candle_date=excluded.last_candle_date,
        summary_json=excluded.summary_json, calculated_at=CURRENT_TIMESTAMP`)
      .bind(JSON.stringify(summaries)).run();
    updated += summaries.length;
  }
  return updated;
}

/** 마이그레이션 적용 전에도 기존 화면을 계속 제공하고, 다음 일봉 수집 때 표를 자동 생성한다. */
export async function readWilliamsSignals(environment, tickers) {
  if (!tickers.length) return new Map();
  const placeholders = tickers.map(() => '?').join(', ');
  try {
    const result = await environment.DB.prepare(`SELECT ticker, summary_json AS summaryJson
      FROM williams_signals WHERE ticker IN (${placeholders})`).bind(...tickers).all();
    return new Map(result.results.flatMap(row => {
      try { return [[row.ticker, JSON.parse(row.summaryJson)]]; }
      catch { return []; }
    }));
  } catch (error) {
    if (String(error.message || error).includes('no such table: williams_signals')) return new Map();
    throw error;
  }
}
