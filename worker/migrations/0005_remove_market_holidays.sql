-- D-Day와 재무 갱신 기준을 주말 제외 방식으로 단순화했다.
-- 과거에 저장된 NYSE 휴장일은 더 이상 어떤 화면·동기화 작업에도 사용하지 않으므로 제거한다.
DROP TABLE IF EXISTS market_holidays;
