// SEC 기간 식별과 출처 기록만 담당한다. 지표의 숫자 선택·계산 정책은 바꾸지 않는다.
export const SEC_FINANCIAL_METADATA_VERSION = 1;

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function durationDays(entry) {
  const start = isoDate(entry?.start);
  const end = isoDate(entry?.end);
  return start && end ? Math.round((new Date(end) - new Date(start)) / 86_400_000) : null;
}

function fiscalYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

/** unit은 fact 내부가 아니라 units의 키다. 선택 시 붙인 단위와 원본 메타데이터를 함께 남긴다. */
export function secSourceReference(entry, role = 'source') {
  return {
    role, tag: entry.tag || null, taxonomy: entry.taxonomy || 'us-gaap',
    form: entry.form || null, accession: entry.accn || entry.accession || null,
    filed: isoDate(entry.filed), start: isoDate(entry.start), end: isoDate(entry.end),
    unit: entry.unit || null, value: Number.isFinite(entry.val) ? entry.val : null,
    fy: fiscalYear(entry.fy), fp: entry.fp || null, frame: entry.frame || null
  };
}

/** 기존 차감값은 그대로 두고, 차감 전 두 원본과 Q4 계산 종류만 추가한다. */
export function secDifferenceMetadata(current, previous) {
  const currentDays = durationDays(current);
  const previousDays = durationDays(previous);
  const isFourthQuarter = ['10-K', '10-K/A'].includes(current.form) && current.fp === 'FY'
    && currentDays >= 330 && currentDays <= 380 && previousDays >= 210 && previousDays <= 310;
  return {
    calculationType: isFourthQuarter ? 'fy_minus_9m' : 'ytd_difference',
    sourceRefs: [secSourceReference(current, 'current_ytd'), secSourceReference(previous, 'previous_ytd')],
    calculationDetails: { formula: 'current_ytd - previous_ytd' }
  };
}

/**
 * 비교기간 fact의 fy/fp는 제출 공시의 회계기간일 수 있다. 선택된 최신 비교값의 fy를 복사하지 않는다.
 * 같은 accession의 실제 최신 기간을 원본 날짜로 확인하고, 그 기간에만 공시의 fy/fp를 연결한다.
 * 월이나 달력 분기로 역산하지 않으며 누락·충돌 시 해당 기간의 FY/Q는 NULL로 둔다.
 */
export function buildSecPeriodIndex(dataSets) {
  const filings = new Map();
  for (const entry of Object.values(dataSets).flat()) {
    const accession = entry.accn || entry.accession;
    const end = isoDate(entry.end);
    const filed = isoDate(entry.filed);
    const days = durationDays(entry);
    if (!accession || !end || !filed || end > filed || days === null || days < 60 || days > 380) continue;
    if (!['10-K', '10-K/A', '10-Q', '10-Q/A'].includes(entry.form)) continue;
    const group = filings.get(accession) || [];
    group.push(entry);
    filings.set(accession, group);
  }
  const index = new Map();
  const addPeriod = (periodType, end, year, period) => {
    const key = `${periodType}:${end}`;
    const identities = index.get(key) || new Map();
    identities.set(`${year}:${period}`, { fiscalYear: year, fiscalPeriod: period });
    index.set(key, identities);
  };
  for (const entries of filings.values()) {
    const contexts = new Map();
    for (const entry of entries) {
      const year = fiscalYear(entry.fy);
      if (year && ['FY', 'Q1', 'Q2', 'Q3'].includes(entry.fp)) {
        contexts.set(`${year}:${entry.fp}:${entry.form}`, { year, period: entry.fp, form: entry.form });
      }
    }
    // 한 공시에서 서로 다른 회계기간이 주장되면 임의로 하나를 고르지 않는다.
    if (contexts.size !== 1) continue;
    const { year, period, form } = [...contexts.values()][0];
    const annual = ['10-K', '10-K/A'].includes(form) && period === 'FY';
    const quarterly = ['10-Q', '10-Q/A'].includes(form) && ['Q1', 'Q2', 'Q3'].includes(period);
    if (!annual && !quarterly) continue;
    const candidates = entries.filter(entry => annual
      ? durationDays(entry) >= 330 && durationDays(entry) <= 380
      : durationDays(entry) >= 60 && durationDays(entry) <= 310);
    const end = candidates.map(entry => entry.end).sort().at(-1);
    if (!end) continue;
    // 현재 기간 fact가 빠지고 과거 비교값만 남은 공시를 현재 FY/Q로 오인하지 않는다.
    // 늦은 수정 공시는 원 공시의 기간 근거를 재사용하며, 그 근거가 없으면 NULL이 안전하다.
    const filed = entries.map(entry => isoDate(entry.filed)).filter(Boolean).sort()[0];
    const filingDelay = Math.round((new Date(filed) - new Date(end)) / 86_400_000);
    if (filingDelay > (annual ? 180 : 60)) continue;
    if (annual) {
      addPeriod('annual', end, year, 'FY');
      addPeriod('quarterly', end, year, 'Q4');
    } else addPeriod('quarterly', end, year, period);
  }
  return index;
}

export function resolveSecPeriodMetadata(index, periodType, end, selectedEntries) {
  const identities = index.get(`${periodType}:${end}`);
  const identity = identities?.size === 1 ? [...identities.values()][0] : null;
  const starts = new Set(selectedEntries.filter(Boolean).filter(entry => {
    const days = durationDays(entry);
    return entry.end === end && days !== null && (periodType === 'annual'
      ? days >= 330 && days <= 380 : days >= 60 && days <= 125);
  }).map(entry => isoDate(entry.start)).filter(Boolean));
  return {
    fiscalYear: identity?.fiscalYear ?? null,
    fiscalPeriod: identity?.fiscalPeriod ?? null,
    periodStart: starts.size === 1 ? [...starts][0] : null
  };
}

function factProvenance(metricName, entry) {
  if (!entry || !Number.isFinite(entry.val)) return null;
  const refs = entry.sourceRefs || [secSourceReference(entry)];
  const primary = refs[0];
  return {
    metricName, metricValue: entry.val, secTag: primary.tag, form: primary.form,
    accessionNumber: primary.accession, filedDate: primary.filed,
    sourceStart: primary.start, sourceEnd: primary.end, unit: primary.unit,
    calculationType: entry.calculationType || 'direct', sourceRefs: refs,
    calculationDetails: entry.calculationDetails || null
  };
}

function derivedProvenance(metricName, value, formula, inputs, unit) {
  if (!Number.isFinite(value) || inputs.some(input => !input)) return null;
  return {
    metricName, metricValue: value, secTag: null, form: null, accessionNumber: null,
    filedDate: null, sourceStart: null, sourceEnd: null, unit, calculationType: 'derived',
    sourceRefs: inputs.flatMap(input => input.sourceRefs.map(ref => ({ ...ref,
      input_metric: input.metricName, input_value: input.metricValue,
      input_calculation_type: input.calculationType }))),
    calculationDetails: { formula, inputs: inputs.map(input => ({ metric: input.metricName,
      value: input.metricValue, calculationType: input.calculationType,
      calculationDetails: input.calculationDetails })) }
  };
}

/** 내부 입력값은 출처 테이블에만 저장한다. FCF·ROE 등의 기존 계산값을 다시 계산하지 않는다. */
export function buildFinancialProvenance(dateSets, end, values) {
  const records = new Map();
  const direct = (metricName, dataSetName) => {
    const record = factProvenance(metricName, dateSets[dataSetName].get(end));
    if (record) records.set(metricName, record);
    return record;
  };
  const derived = (metricName, value, formula, inputs, unit = 'USD') => {
    const record = derivedProvenance(metricName, value, formula, inputs, unit);
    if (record) records.set(metricName, record);
    return record;
  };
  const interest = direct('net_interest_income', 'netInterestIncome');
  const noninterest = direct('noninterest_income', 'noninterestIncome');
  const expenses = direct('operating_expenses', 'operatingExpenses');
  const revenue = direct('revenue', 'revenue') || derived('revenue', values.revenue,
    'net_interest_income + noninterest_income', [interest, noninterest]);
  const operatingIncome = direct('operating_income', 'operatingIncome') || derived('operating_income',
    values.operatingIncome, 'revenue - operating_expenses', [revenue, expenses]);
  const netIncome = direct('net_income', 'netIncome');
  direct('eps', 'eps');
  const cashFlow = direct('operating_cash_flow', 'operatingCashFlow');
  const capitalExpenditure = direct('capital_expenditure', 'capitalExpenditure');
  const grossProfit = direct('gross_profit', 'grossProfit');
  const equity = direct('stockholders_equity', 'equity');
  derived('free_cash_flow', values.freeCashFlow, 'operating_cash_flow - abs(capital_expenditure)',
    [cashFlow, capitalExpenditure]);
  derived('gross_margin', values.grossMargin, 'gross_profit / revenue * 100', [grossProfit, revenue], '%');
  derived('operating_margin', values.operatingMargin, 'operating_income / revenue * 100',
    [operatingIncome, revenue], '%');
  derived('roe', values.roe, 'net_income / stockholders_equity * 100', [netIncome, equity], '%');
  return [...records.values()];
}

/** 부모 재무 행과 같은 DB.batch에서 실행해 값과 출처가 서로 다른 수집 결과가 되지 않게 한다. */
export function financialProvenanceStatements(environment, ticker, periodType, records) {
  return [
    environment.DB.prepare('DELETE FROM financial_metric_provenance WHERE ticker=? AND period_type=?')
      .bind(ticker, periodType),
    environment.DB.prepare(`INSERT INTO financial_metric_provenance
      (ticker, period_type, fiscal_period_end, metric_name, sec_tag, form, accession_number,
       filed_date, source_start, source_end, unit, calculation_type, source_refs_json,
       metric_value, calculation_details_json)
      SELECT ?, ?, json_extract(value, '$.fiscalPeriodEnd'), json_extract(value, '$.metricName'),
        json_extract(value, '$.secTag'), json_extract(value, '$.form'), json_extract(value, '$.accessionNumber'),
        json_extract(value, '$.filedDate'), json_extract(value, '$.sourceStart'), json_extract(value, '$.sourceEnd'),
        json_extract(value, '$.unit'), json_extract(value, '$.calculationType'), json_extract(value, '$.sourceRefs'),
        json_extract(value, '$.metricValue'), json_extract(value, '$.calculationDetails')
      FROM json_each(?)`).bind(ticker, periodType, JSON.stringify(records))
  ];
}
