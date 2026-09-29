-- Business Quant 원본은 공급원 정정만 갱신하고, 응답 누락을 이유로 삭제하지 않는다.
CREATE TABLE IF NOT EXISTS bq_dividend_history (
  ticker TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  payment_date TEXT,
  dividend REAL NOT NULL CHECK (dividend > 0),
  source TEXT NOT NULL DEFAULT 'businessquant',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (ticker, ex_date, source)
);
CREATE INDEX IF NOT EXISTS idx_bq_history_payment ON bq_dividend_history(ticker, payment_date DESC);

-- 화면은 이 요약과 원본 테이블만 읽는다. 이전 공급원의 테이블은 그대로 보존한다.
CREATE TABLE IF NOT EXISTS bq_dividend_summary (
  ticker TEXT PRIMARY KEY,
  history_start TEXT,
  history_end TEXT,
  history_count INTEGER NOT NULL DEFAULT 0,
  ttm_dividend REAL,
  metadata_divyield REAL,
  metadata_nextdividend TEXT,
  dividend_frequency TEXT,
  paid_dividend_1y REAL,
  paid_payout_count INTEGER,
  last_paid_dividend REAL,
  last_paid_ex_date TEXT,
  last_paid_payment_date TEXT,
  next_dividend REAL,
  next_ex_date TEXT,
  next_payment_date TEXT,
  growth_rate_1y REAL,
  growth_rate_5y REAL,
  growth_rate_10y REAL,
  growth_years_available_history INTEGER,
  last_bq_fetch_at TEXT,
  next_bq_fetch_at TEXT,
  estimated_next_ex_date TEXT,
  confirmed_next_ex_date TEXT,
  fetch_priority INTEGER NOT NULL DEFAULT 6,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  last_fetch_error TEXT,
  massive_dividend_event_detected_at TEXT,
  businessquant_updated_at TEXT,
  special_filter_note TEXT
);

-- 한 행이 실제 API 1회 예약을 의미한다. 날짜별 집계와 최근 24시간 집계를 모두 제한한다.
CREATE TABLE IF NOT EXISTS bq_api_requests (
  utc_day TEXT NOT NULL,
  ticker TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  http_status INTEGER,
  result_status TEXT,
  PRIMARY KEY (utc_day, ticker)
);
CREATE INDEX IF NOT EXISTS idx_bq_api_attempted ON bq_api_requests(attempted_at);
CREATE TABLE IF NOT EXISTS bq_api_pause (
  utc_day TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  paused_at TEXT NOT NULL
);

-- Massive 새 선언의 재확인을 위한 상태이며 기존 Massive 원본은 보존한다.
CREATE TABLE IF NOT EXISTS massive_dividend_checks (
  ticker TEXT PRIMARY KEY,
  last_checked_at TEXT,
  next_check_at TEXT,
  last_error TEXT
);
