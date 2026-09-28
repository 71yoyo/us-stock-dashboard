-- Alpha Vantage 검증 중에는 기존 SEC/Massive 배당 원본을 보존한다.
-- 종목별 새 이력을 완전히 받은 뒤에만 읽기 공급원을 전환한다.
CREATE TABLE IF NOT EXISTS alpha_dividend_events (
  ticker TEXT NOT NULL,
  event_key TEXT NOT NULL,
  declaration_date TEXT,
  ex_dividend_date TEXT NOT NULL,
  record_date TEXT,
  payment_date TEXT,
  amount REAL NOT NULL,
  split_adjusted_amount REAL NOT NULL,
  PRIMARY KEY (ticker, event_key)
);
CREATE INDEX IF NOT EXISTS idx_alpha_dividend_date
  ON alpha_dividend_events(ticker, ex_dividend_date DESC);

CREATE TABLE IF NOT EXISTS alpha_dividend_sync (
  ticker TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  event_count INTEGER NOT NULL DEFAULT 0,
  split_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS alpha_api_budget (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

-- fundamental_jobs는 첫 요청에 생성되므로 기존 작업 초기화는 seedJobs에서 수행한다.
