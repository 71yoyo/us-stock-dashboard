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
