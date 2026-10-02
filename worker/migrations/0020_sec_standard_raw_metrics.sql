-- 기존 재무/특화 값은 수정하지 않는다. 시점·기간·평균 값의 의미를 별도 저장한다.
CREATE TABLE sec_standard_raw_metrics (
  ticker TEXT NOT NULL REFERENCES companies(ticker),
  metric_name TEXT NOT NULL CHECK (metric_name IN (
    'shares_outstanding','cash_and_cash_equivalents','total_assets','stockholders_equity',
    'equity_including_nci','weighted_average_shares_basic','weighted_average_shares_diluted',
    'interest_expense','consolidated_net_income','income_tax_expense','depreciation_and_amortization','ebit','ebitda')),
  period_type TEXT NOT NULL CHECK (period_type IN ('instant','annual','quarterly','ytd')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('point_in_time','period','period_average')),
  entity_scope TEXT NOT NULL CHECK (entity_scope IN ('parent','consolidated')),
  unit TEXT NOT NULL CHECK (unit IN ('USD','shares')),
  metric_value REAL,
  availability TEXT NOT NULL CHECK (availability IN ('available','missing','needs_review')),
  reason TEXT,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  source_fingerprint TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(ticker,metric_name,period_type,period_start,period_end),
  CHECK ((period_type='instant' AND value_kind='point_in_time' AND period_start='') OR
    (period_type!='instant' AND value_kind!='point_in_time' AND period_start!='')),
  CHECK ((availability='available' AND metric_value IS NOT NULL AND source_fingerprint IS NOT NULL) OR
    (availability!='available' AND metric_value IS NULL AND source_fingerprint IS NULL))
);

-- 기존 financial_metric_provenance의 부모 PK/FK에 묶이지 않는다.
-- 같은 기간의 정정 전 출처도 append-only로 보존한다. fingerprint는 출처와 입력값 전체의 SHA-256이다.
CREATE TABLE sec_standard_raw_provenance (
  ticker TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  period_type TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  metric_value REAL NOT NULL,
  sec_tag TEXT,
  form TEXT,
  accession_number TEXT,
  filed_date TEXT,
  source_start TEXT,
  source_end TEXT,
  unit TEXT NOT NULL,
  calculation_type TEXT NOT NULL CHECK (calculation_type IN ('direct','ytd_difference','fy_minus_9m','derived')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  calculation_details_json TEXT NOT NULL CHECK (json_valid(calculation_details_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(ticker,metric_name,period_type,period_start,period_end,source_fingerprint),
  FOREIGN KEY(ticker,metric_name,period_type,period_start,period_end)
    REFERENCES sec_standard_raw_metrics(ticker,metric_name,period_type,period_start,period_end)
);
CREATE INDEX idx_sec_standard_raw_period ON sec_standard_raw_metrics(ticker,period_type,period_end);
CREATE INDEX idx_sec_standard_raw_accession ON sec_standard_raw_provenance(ticker,accession_number);
