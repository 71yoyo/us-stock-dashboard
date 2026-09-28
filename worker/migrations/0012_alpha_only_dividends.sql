-- SEC 배당 전용 집계/기간 이력을 제거한다. SEC 재무 지표와 Massive 보류 원본은 유지한다.
DROP TABLE IF EXISTS dividend_periods;
DROP TABLE IF EXISTS dividend_metrics;

-- 과거 공통 이벤트 테이블에 SEC 출처가 있다면 해당 행만 지운다.
DELETE FROM dividend_events WHERE source = 'SEC EDGAR';

-- 이전 SEC 배당 작업 상태가 Alpha Vantage 저장 완료로 오인되지 않도록 정리한다.
-- 이 작업 테이블은 과거에는 런타임에만 생성했으므로 신규 DB에서도 마이그레이션이 동작해야 한다.
CREATE TABLE IF NOT EXISTS fundamental_jobs (
  ticker TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  checked_at TEXT, next_run_at TEXT, lease_until TEXT, lease_token TEXT,
  details TEXT, error TEXT, PRIMARY KEY(ticker, kind)
);
UPDATE fundamental_jobs SET status = 'pending', checked_at = NULL, next_run_at = NULL,
  details = '{}', error = NULL
WHERE kind = 'dividends' AND details LIKE '%SEC EDGAR%'
  AND NOT EXISTS (
    SELECT 1 FROM alpha_dividend_sync a
    WHERE a.ticker = fundamental_jobs.ticker AND a.status = 'ready'
  );
UPDATE fundamental_jobs SET details = '{}'
WHERE kind = 'dividends' AND details LIKE '%SEC EDGAR%';
