-- Massive 검증 전에는 FMP 일봉을 그대로 화면에 남기고, 교체 후에도 원본을 복구할 수 있게 보관한다.
CREATE TABLE IF NOT EXISTS archived_fmp_candles (
  ticker TEXT NOT NULL,
  candle_date TEXT NOT NULL,
  open_price REAL,
  high_price REAL,
  low_price REAL,
  close_price REAL,
  adjusted_close REAL,
  volume REAL,
  cached_at TEXT,
  PRIMARY KEY (ticker, candle_date)
);
INSERT OR IGNORE INTO archived_fmp_candles
  (ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, cached_at)
SELECT ticker, candle_date, open_price, high_price, low_price, close_price, adjusted_close, volume, cached_at
FROM price_candles WHERE source = 'FMP';

-- 완료 표시는 한 날짜의 종가와 3개월 적재를 혼동하지 않도록 별도로 유지한다.
CREATE TABLE IF NOT EXISTS massive_candle_backfills (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO massive_candle_backfills(ticker)
SELECT ticker FROM price_candles GROUP BY ticker
HAVING SUM(CASE WHEN source='MASSIVE' THEN 1 ELSE 0 END) >= 50
  AND MIN(CASE WHEN source='MASSIVE' THEN candle_date END) <= date('now', '-70 days')
  AND MAX(CASE WHEN source='MASSIVE' THEN candle_date END) >= date('now', '-14 days')
  AND SUM(CASE WHEN source='FMP' THEN 1 ELSE 0 END) = 0;

-- 기존 FMP 성공 시각은 Massive 3개월 적재 완료를 뜻하지 않으므로 재확인 대상으로 돌린다.
UPDATE data_sync_state SET last_success_at = NULL, last_attempt_at = NULL, next_retry_at = NULL
  WHERE data_type = 'candles' AND ticker NOT IN (SELECT ticker FROM massive_candle_backfills);

-- 전체 시장 일봉은 날짜마다 한 번만 받는다. 임대가 만료되면 실패한 시도만 다시 가져온다.
CREATE TABLE IF NOT EXISTS massive_daily_market_sync (
  market_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'retry', 'success')),
  last_attempt_at TEXT,
  lease_until TEXT,
  completed_at TEXT,
  last_error TEXT
);
