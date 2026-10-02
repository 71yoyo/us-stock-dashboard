-- legacy 재무 job과 독립된 raw 처리 버전/재시도/임대 상태다. 기존 수치나 migration은 변경하지 않는다.
CREATE TABLE sec_raw_runtime (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker),
  raw_schema_version INTEGER NOT NULL DEFAULT 1,
  raw_data_version INTEGER NOT NULL DEFAULT 0,
  raw_status TEXT NOT NULL DEFAULT 'pending' CHECK(raw_status IN ('pending','running','ready','error')),
  raw_last_accession TEXT,
  raw_last_success_at TEXT,
  raw_last_error TEXT,
  next_run_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_accession TEXT,
  attempt_data_version INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  available_count INTEGER NOT NULL DEFAULT 0,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX sec_raw_runtime_due ON sec_raw_runtime(next_run_at,lease_until);

-- 원자 batch 진입 시 소유권을 확인하는 임시 guard다. 성공/실패 후 영구 자료가 쌓이지 않는다.
CREATE TABLE sec_raw_runtime_guard (
  ticker TEXT PRIMARY KEY REFERENCES sec_raw_runtime(ticker),
  lease_token TEXT NOT NULL,
  fence INTEGER NOT NULL
);
CREATE TRIGGER sec_raw_runtime_fence BEFORE INSERT ON sec_raw_runtime_guard
BEGIN
  SELECT RAISE(ABORT,'SEC_RAW_LEASE_LOST') WHERE NOT EXISTS (
    SELECT 1 FROM sec_raw_runtime r WHERE r.ticker=NEW.ticker
      AND r.lease_token=NEW.lease_token AND r.fence=NEW.fence
      AND r.raw_status='running' AND julianday(r.lease_until)>julianday('now')
  );
END;
