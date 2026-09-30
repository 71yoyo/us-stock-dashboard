-- 회사 분류만 추가한다. 기존 회사·재무값을 갱신하거나 분류를 추측해 seed하지 않는다.
-- 현재 ticker PK/FK를 유지하고 CIK를 보조 식별자로 보존한다. 복수 share class는 CIK가 같을 수 있다.
CREATE TABLE company_classification (
  ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
  company_cik TEXT,
  auto_profile TEXT NOT NULL CHECK (auto_profile IN ('GENERAL','REIT','BANK','EXCHANGE','UNKNOWN')),
  effective_profile TEXT NOT NULL CHECK (effective_profile IN ('GENERAL','REIT','BANK','EXCHANGE','UNKNOWN')),
  source_sector TEXT,
  source_industry TEXT,
  classification_reason TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high','low')),
  rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
  manual_override TEXT CHECK (manual_override IS NULL OR manual_override IN ('GENERAL','REIT','BANK','EXCHANGE','UNKNOWN')),
  manual_override_reason TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('classified','needs_review','overridden')),
  classified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_profile = COALESCE(manual_override, auto_profile)),
  CHECK ((manual_override IS NULL AND manual_override_reason IS NULL)
    OR (manual_override IS NOT NULL AND manual_override_reason IS NOT NULL
      AND length(trim(manual_override_reason)) BETWEEN 1 AND 1000)),
  CHECK (review_status = CASE WHEN manual_override IS NOT NULL THEN 'overridden'
    WHEN auto_profile='UNKNOWN' THEN 'needs_review' ELSE 'classified' END)
);
CREATE INDEX idx_company_classification_profile ON company_classification(effective_profile, review_status);
CREATE INDEX idx_company_classification_cik ON company_classification(company_cik);
