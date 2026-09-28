-- 무료 키는 하루 25회와 초당 요청 간격을 함께 지켜야 한다.
-- 수동 실행과 Cron이 겹쳐도 D1의 원자적 임대로 요청을 분리한다.
CREATE TABLE IF NOT EXISTS alpha_api_throttle (
  name TEXT PRIMARY KEY,
  next_allowed_at TEXT NOT NULL
);
