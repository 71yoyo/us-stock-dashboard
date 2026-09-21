-- 금융 API 원본·캐시를 Cloudflare D1에 저장한다.
-- 이 파일은 코드와 함께 GitHub에서 버전 관리하지만, 실제 데이터와 API 키는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS companies (
  ticker TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  exchange TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_quotes (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  current_price REAL,
  previous_close REAL,
  change_amount REAL,
  change_percent REAL,
  market_updated_at TEXT,
  cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_candles (
  ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  candle_date TEXT NOT NULL,
  open_price REAL,
  high_price REAL,
  low_price REAL,
  close_price REAL,
  adjusted_close REAL,
  volume INTEGER,
  cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, candle_date)
);

CREATE TABLE IF NOT EXISTS dividend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  declaration_date TEXT,
  ex_dividend_date TEXT,
  record_date TEXT,
  payment_date TEXT,
  amount REAL,
  frequency TEXT,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  UNIQUE (ticker, ex_dividend_date, payment_date, amount)
);

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  fiscal_period_end TEXT NOT NULL,
  revenue REAL,
  operating_income REAL,
  net_income REAL,
  eps REAL,
  free_cash_flow REAL,
  total_debt REAL,
  cash_and_equivalents REAL,
  cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ticker, fiscal_period_end)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_type TEXT NOT NULL,
  ticker TEXT,
  status TEXT NOT NULL,
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_candles_ticker_date ON price_candles (ticker, candle_date DESC);
CREATE INDEX IF NOT EXISTS idx_dividend_events_ticker_date ON dividend_events (ticker, ex_dividend_date DESC);
CREATE INDEX IF NOT EXISTS idx_financial_snapshots_ticker_period ON financial_snapshots (ticker, fiscal_period_end DESC);
