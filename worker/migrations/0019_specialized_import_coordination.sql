-- 관리자 historical importer 전용이다. 기존 재무/분류/특화지표 값은 변경하지 않는다.
CREATE TABLE specialized_import_registry (
  dataset_key TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL,
  target_db_id TEXT NOT NULL,
  target_db_name TEXT NOT NULL,
  target_environment TEXT NOT NULL CHECK(target_environment IN ('production','rehearsal')),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  semantic_digest TEXT NOT NULL CHECK(length(semantic_digest)=64),
  parser_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','failed','completed')),
  completed_documents INTEGER NOT NULL DEFAULT 0 CHECK(completed_documents BETWEEN 0 AND 40),
  last_document TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts>0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT
);
-- dataset별 lock이 아니라 importer 전체 lock을 사용해 서로 다른 dataset writer도 직렬화한다.
CREATE TABLE specialized_import_lease (
  lock_key TEXT PRIMARY KEY CHECK(lock_key='specialized'),
  dataset_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>0),
  expires_ms INTEGER NOT NULL CHECK(expires_ms>=0)
);
-- INSERT ... ON CONFLICT로 CHECK를 강제한다. guard row 삭제 시 UPDATE 0행으로 우회되지 않는다.
CREATE TABLE specialized_import_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  ok INTEGER NOT NULL CHECK(ok=1)
);
