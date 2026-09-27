-- 기존 SEC 배당 이력과 FMP 일봉은 보존하면서 신규 공급원의 원본 필드를 기록한다.
ALTER TABLE price_candles ADD COLUMN source TEXT NOT NULL DEFAULT 'FMP';

-- 기존 dividend_events의 날짜·금액 UNIQUE는 다른 유형의 동시 배당을 합칠 수 있어 원본 ID 기준으로 별도 저장한다.
CREATE TABLE IF NOT EXISTS massive_dividend_events (
  ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  declaration_date TEXT,
  ex_dividend_date TEXT NOT NULL,
  record_date TEXT,
  payment_date TEXT,
  amount REAL NOT NULL,
  split_adjusted_amount REAL,
  distribution_type TEXT,
  frequency INTEGER,
  source_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_massive_dividend_date
  ON massive_dividend_events(ticker, ex_dividend_date DESC);

-- 무료 요금제의 분당 호출 제한을 Cron과 수동 갱신이 함께 지키도록 한다.
CREATE TABLE IF NOT EXISTS massive_api_budget (
  minute TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fmp_candle_blocks (
  ticker TEXT PRIMARY KEY,
  retry_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- 이전 FMP 배당 성공/402 상태는 새 Massive 작업의 완료를 뜻하지 않는다.
-- 저장된 원본은 보존하고 큐 시각만 초기화해 다음 Cron에서 새 공급원을 확인한다.
UPDATE data_sync_state SET last_success_at=NULL, last_attempt_at=NULL, next_retry_at=NULL
  WHERE data_type='dividends';
UPDATE data_sync_state SET last_attempt_at=NULL, next_retry_at=NULL
  WHERE data_type='candles' AND last_error LIKE '%402%';
