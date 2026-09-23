-- 예전 이벤트는 출처가 검증되지 않았으므로 그대로 보존하되 새 계산에서는 제외한다.
ALTER TABLE dividend_events ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS idx_dividend_events_source_date
  ON dividend_events (ticker, source, ex_dividend_date DESC);
