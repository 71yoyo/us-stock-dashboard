-- 브라우저별 localStorage에 흩어졌던 관심종목 목록을 한 계정의 D1 데이터로 동기화한다.
-- 금융 원본 데이터와 사용자별 관심종목 설정을 분리해, 시세 갱신이 사용자 순서를 바꾸지 않게 한다.
CREATE TABLE IF NOT EXISTS user_watchlist (
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('dividend', 'price')),
  display_order INTEGER NOT NULL,
  display_name TEXT,
  sector TEXT,
  saved_price REAL,
  saved_change REAL,
  saved_change_percent REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_user_watchlist_order
  ON user_watchlist (user_id, display_order);
