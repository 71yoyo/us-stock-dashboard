-- 0012 이전에 남은 SEC 배당 작업 오류/설명을 Alpha 상태와 분리한다.
-- 재무 작업과 Alpha/Massive 배당 원본은 변경하지 않는다.
UPDATE fundamental_jobs SET status='pending', checked_at=NULL, next_run_at=NULL,
  details='{}', error=NULL
WHERE kind='dividends'
  AND (COALESCE(details, '') LIKE '%SEC EDGAR%' OR COALESCE(error, '') LIKE '%SEC%')
  AND NOT EXISTS (
    SELECT 1 FROM alpha_dividend_sync a WHERE a.ticker=fundamental_jobs.ticker
      AND a.status='ready' AND a.last_success_at IS NOT NULL
      AND a.event_count=(SELECT COUNT(*) FROM alpha_dividend_events e WHERE e.ticker=a.ticker)
  );

UPDATE fundamental_jobs SET status='ready',
  checked_at=(SELECT a.last_success_at FROM alpha_dividend_sync a WHERE a.ticker=fundamental_jobs.ticker),
  details=json_object('source', 'ALPHA_VANTAGE', 'eventCount',
    (SELECT COUNT(*) FROM alpha_dividend_events e WHERE e.ticker=fundamental_jobs.ticker)),
  error=NULL
WHERE kind='dividends'
  AND (COALESCE(details, '') LIKE '%SEC EDGAR%' OR COALESCE(error, '') LIKE '%SEC%')
  AND EXISTS (
    SELECT 1 FROM alpha_dividend_sync a WHERE a.ticker=fundamental_jobs.ticker
      AND a.status='ready' AND a.last_success_at IS NOT NULL
      AND a.event_count=(SELECT COUNT(*) FROM alpha_dividend_events e WHERE e.ticker=a.ticker)
  );
