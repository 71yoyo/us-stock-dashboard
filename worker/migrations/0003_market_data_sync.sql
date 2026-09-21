-- 재무·배당의 원본 이벤트와 화면용 계산값을 분리해, 새 공시가 들어와도 과거 값을 보존한다.
ALTER TABLE companies ADD COLUMN cik TEXT;

CREATE TABLE IF NOT EXISTS financial_metrics (
  ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  period_type TEXT NOT NULL CHECK (period_type IN ('annual', 'quarterly')),
  fiscal_period_end TEXT NOT NULL,
  reported_date TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  revenue REAL,
  operating_income REAL,
  net_income REAL,
  eps REAL,
  peg_ratio REAL,
  pe_ratio REAL,
  ps_ratio REAL,
  free_cash_flow REAL,
  roe REAL,
  roic REAL,
  gross_margin REAL,
  operating_margin REAL,
  source TEXT NOT NULL,
  source_updated_at TEXT,
  cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, period_type, fiscal_period_end)
);

CREATE TABLE IF NOT EXISTS dividend_metrics (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  annual_dividend REAL,
  quarterly_dividend REAL,
  dividend_yield REAL,
  dividend_growth_years INTEGER,
  dividend_growth_cagr_10y REAL,
  next_ex_dividend_date TEXT,
  next_date_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (next_date_status IN ('confirmed', 'estimated', 'unknown')),
  next_payment_date TEXT,
  calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cron이 실행 중간에 끝나도, 다음 실행에서 실패 종목만 재시도할 수 있게 동기화 상태를 영속화한다.
CREATE TABLE IF NOT EXISTS data_sync_state (
  ticker TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('profile', 'price', 'candles', 'dividends', 'financials')),
  last_success_at TEXT,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (ticker, data_type)
);

-- 미국 거래일 기준 D-Day 계산에 쓰는 NYSE 휴장일을 연도별로 보관한다.
CREATE TABLE IF NOT EXISTS market_holidays (
  market TEXT NOT NULL DEFAULT 'NYSE',
  holiday_date TEXT NOT NULL,
  name TEXT NOT NULL,
  is_full_close INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'NYSE',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (market, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_financial_metrics_chart
  ON financial_metrics (ticker, period_type, fiscal_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_dividend_events_history
  ON dividend_events (ticker, ex_dividend_date DESC, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_sync_state_retry
  ON data_sync_state (data_type, next_retry_at);
