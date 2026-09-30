-- 기존 금액과 API 필드는 유지한다. SEC 근거 없이 과거 FY/Q를 역산하지 않는다.
ALTER TABLE financial_metrics ADD COLUMN fiscal_year INTEGER
  CHECK (fiscal_year IS NULL OR fiscal_year BETWEEN 1000 AND 9999);
ALTER TABLE financial_metrics ADD COLUMN fiscal_period TEXT
  CHECK (fiscal_period IS NULL OR fiscal_period IN ('FY', 'Q1', 'Q2', 'Q3', 'Q4'));
ALTER TABLE financial_metrics ADD COLUMN period_start TEXT;

-- 한 재무 행의 지표마다 공시가 다를 수 있으므로 출처는 지표별로 분리한다.
-- 내부 입력값도 metric_value/source_refs_json에 보존하며 재무 본표의 원액 열은 늘리지 않는다.
CREATE TABLE financial_metric_provenance (
  ticker TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('annual', 'quarterly')),
  fiscal_period_end TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  sec_tag TEXT,
  form TEXT,
  accession_number TEXT,
  filed_date TEXT,
  source_start TEXT,
  source_end TEXT,
  unit TEXT,
  calculation_type TEXT NOT NULL
    CHECK (calculation_type IN ('direct', 'ytd_difference', 'fy_minus_9m', 'derived')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  metric_value REAL NOT NULL,
  calculation_details_json TEXT CHECK (calculation_details_json IS NULL OR json_valid(calculation_details_json)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, period_type, fiscal_period_end, metric_name),
  FOREIGN KEY (ticker, period_type, fiscal_period_end)
    REFERENCES financial_metrics(ticker, period_type, fiscal_period_end) ON DELETE CASCADE
);

CREATE INDEX idx_financial_metric_provenance_filing
  ON financial_metric_provenance(ticker, accession_number);
