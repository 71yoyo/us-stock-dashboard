-- BQ 이력과 Massive 원본은 유지하고 사용 종료된 Alpha 배당 저장소만 제거한다.
-- 기존 마이그레이션 파일은 운영 DB의 적용 순서를 위해 보존한다.
DELETE FROM fundamental_jobs WHERE kind = 'dividends';
DELETE FROM dividend_events WHERE source = 'ALPHA_VANTAGE';
DROP TABLE IF EXISTS alpha_dividend_events;
DROP TABLE IF EXISTS alpha_dividend_sync;
DROP TABLE IF EXISTS alpha_api_budget;
DROP TABLE IF EXISTS alpha_api_throttle;
