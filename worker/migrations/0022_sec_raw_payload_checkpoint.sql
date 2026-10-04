-- accession만으로는 같은 공시의 정정 payload를 구분할 수 없다.
-- 기존 registry/수치/상태 의미를 바꾸지 않고 완료한 source identity만 별도 보존한다.
CREATE TABLE sec_raw_payload_checkpoint (
  ticker TEXT NOT NULL REFERENCES sec_raw_runtime(ticker),
  channel TEXT NOT NULL CHECK(channel IN ('historical','compact')),
  accession TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source_identity TEXT NOT NULL CHECK(length(source_identity)=64),
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(ticker,channel)
);
