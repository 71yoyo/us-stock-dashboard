-- 일봉 기준 신호를 기기와 새로고침 사이에 유지한다. 계산 원본은 price_candles에 남긴다.
CREATE TABLE IF NOT EXISTS williams_signals (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  last_candle_date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
