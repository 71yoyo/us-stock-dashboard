-- 종목별 실적 발표 일정을 따로 보관해, 재무 원문을 필요한 시점에만 갱신한다.
CREATE TABLE IF NOT EXISTS earnings_schedule (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  next_earnings_date TEXT,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'FMP',
  last_checked_at TEXT,
  last_financial_refresh_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_earnings_schedule_next_date
  ON earnings_schedule (next_earnings_date);
