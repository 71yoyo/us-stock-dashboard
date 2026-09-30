-- 산업 특화지표는 기존 GAAP 테이블을 수정하지 않고 정의·값·출처를 분리한다.
CREATE TABLE company_metric_definitions (
  metric_code TEXT NOT NULL,
  definition_owner TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('GENERAL','REIT','BANK','EXCHANGE','UNKNOWN')),
  metric_family TEXT NOT NULL,
  default_unit TEXT NOT NULL,
  definition_source TEXT NOT NULL,
  definition_notes TEXT NOT NULL,
  PRIMARY KEY (metric_code, definition_owner, definition_version)
);

CREATE TABLE company_metric_values (
  record_key TEXT PRIMARY KEY,
  ticker TEXT NOT NULL REFERENCES companies(ticker),
  metric_code TEXT NOT NULL,
  definition_owner TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  period_scope TEXT NOT NULL CHECK (period_scope IN ('annual','quarterly','ytd','ttm')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK (period_end >= period_start),
  period_label TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  fiscal_period TEXT NOT NULL,
  value_basis TEXT NOT NULL CHECK (value_basis IN ('total','per_share','percentage','ratio','count')),
  share_basis TEXT NOT NULL CHECK (share_basis IN ('not_applicable','basic','diluted')),
  attribution_basis TEXT NOT NULL,
  raw_value REAL NOT NULL,
  raw_unit TEXT NOT NULL,
  raw_unit_multiplier REAL NOT NULL CHECK (raw_unit_multiplier > 0),
  canonical_value REAL NOT NULL,
  canonical_unit TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('parsed','validated','needs_review','rejected')),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  FOREIGN KEY (metric_code, definition_owner, definition_version)
    REFERENCES company_metric_definitions(metric_code, definition_owner, definition_version),
  UNIQUE (ticker,metric_code,definition_owner,definition_version,period_scope,period_start,period_end,
    value_basis,share_basis,attribution_basis)
);
CREATE INDEX company_metric_values_lookup
  ON company_metric_values(ticker,metric_code,period_scope,period_end);

-- 동일 값에 SEC/IR 등 여러 출처를 붙이되, 값을 복제하거나 출처를 덮어쓰지 않는다.
CREATE TABLE company_metric_sources (
  record_key TEXT NOT NULL REFERENCES company_metric_values(record_key),
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  accession_number TEXT,
  exhibit TEXT,
  document_name TEXT NOT NULL,
  filed_at TEXT,
  published_at TEXT NOT NULL,
  table_title TEXT NOT NULL,
  section TEXT NOT NULL,
  page_number INTEGER,
  source_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_metadata_json TEXT NOT NULL CHECK (json_valid(source_metadata_json)),
  PRIMARY KEY (record_key,source_url,source_hash)
);
