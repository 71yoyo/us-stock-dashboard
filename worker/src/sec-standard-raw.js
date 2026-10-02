import { buildSecPeriodIndex, resolveSecPeriodMetadata, secSourceReference,
  secDifferenceMetadata } from './sec-financial-metadata.js';

// 검증된 표준 태그만 사용한다. 총부채/EV/시장가치와 issuer별 custom tag는 이번 단계에서 제외한다.
export const STANDARD_RAW_METRICS = Object.freeze({
  shares_outstanding: { kind: 'point_in_time', unit: 'shares', scope: 'parent',
    tags: ['CommonStockSharesOutstanding', 'dei:EntityCommonStockSharesOutstanding'] },
  cash_and_cash_equivalents: { kind: 'point_in_time', unit: 'USD', scope: 'consolidated',
    tags: ['CashAndCashEquivalentsAtCarryingValue'] },
  total_assets: { kind: 'point_in_time', unit: 'USD', scope: 'consolidated', tags: ['Assets'] },
  stockholders_equity: { kind: 'point_in_time', unit: 'USD', scope: 'parent', tags: ['StockholdersEquity'] },
  equity_including_nci: { kind: 'point_in_time', unit: 'USD', scope: 'consolidated',
    tags: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  weighted_average_shares_basic: { kind: 'period_average', unit: 'shares', scope: 'parent',
    tags: ['WeightedAverageNumberOfSharesOutstandingBasic'] },
  weighted_average_shares_diluted: { kind: 'period_average', unit: 'shares', scope: 'parent',
    tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'] },
  interest_expense: { kind: 'period', unit: 'USD', scope: 'consolidated',
    tags: ['InterestExpenseOperating', 'InterestExpense'] },
  consolidated_net_income: { kind: 'period', unit: 'USD', scope: 'consolidated', tags: ['ProfitLoss'] },
  income_tax_expense: { kind: 'period', unit: 'USD', scope: 'consolidated', tags: ['IncomeTaxExpenseBenefit'] },
  depreciation_and_amortization: { kind: 'period', unit: 'USD', scope: 'consolidated',
    tags: ['DepreciationDepletionAndAmortization'] },
  ebit: { kind: 'period', unit: 'USD', scope: 'consolidated', tags: [] },
  ebitda: { kind: 'period', unit: 'USD', scope: 'consolidated', tags: [] }
});

const FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A'];
const ANNUAL_FORMS = ['10-K', '10-K/A'];
const QUARTER_FORMS = ['10-Q', '10-Q/A'];
const DAY = 86400000;
const scopeBasis = 'SEC CompanyFacts 회사 전체 표준 태그; 차원별/custom fact 제외';

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const days = entry => validDate(entry.start) && validDate(entry.end)
  ? (new Date(entry.end) - new Date(entry.start)) / DAY : null;
const nextDay = end => new Date(new Date(end).getTime() + DAY).toISOString().slice(0, 10);

/** DEI는 cover-page 시점 자료다. 날짜를 재무기간 말로 이동하거나 평균 주식 수로 대체하지 않는다. */
function collect(facts, definition) {
  return definition.tags.flatMap((qualified, tagPriority) => {
    const [taxonomy, tag] = qualified.includes(':') ? qualified.split(':') : ['us-gaap', qualified];
    const entries = facts?.[taxonomy]?.[tag]?.units?.[definition.unit];
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && validDate(entry.end) && validDate(entry.filed)
      && entry.end <= entry.filed && typeof entry.val === 'number' && Number.isFinite(entry.val)
      && FORMS.includes(entry.form) && typeof entry.accn === 'string' && entry.accn.length > 0
      && (!entry.start || validDate(entry.start)) && !entry.segment && !entry.dimensions
      && (definition.unit !== 'shares' || entry.val >= 0))
      .map(entry => ({ ...entry, tag, taxonomy, tagPriority, unit: definition.unit,
        entityScope: entry.entityScope || definition.scope }));
  });
}

function latest(entries) {
  if (!entries.length) return null;
  // 동일 기간에서는 최신 공시가 우선이고, 같은 공시 날짜에만 명시적 태그 우선순위를 적용한다.
  const ordered = [...entries].sort((a, b) => Number(Boolean(a.derived)) - Number(Boolean(b.derived))
    || b.filed.localeCompare(a.filed) || a.tagPriority - b.tagPriority);
  const first = ordered[0];
  const ties = ordered.filter(entry => Boolean(entry.derived) === Boolean(first.derived)
    && entry.filed === first.filed && entry.tagPriority === first.tagPriority);
  // 같은 우선순위의 서로 다른 수치/연결 범위는 임의 선택하지 않는다.
  if (ties.some(entry => entry.val !== first.val || entry.entityScope !== first.entityScope)) return null;
  return first;
}

/** 기간 합계에만 누적 차감을 허용한다. 재작성 위험을 피하려고 같은 공시의 두 원본을 요구한다. */
function quarterlyDifferences(entries, definition) {
  if (definition.kind !== 'period') return [];
  const derived = [];
  for (const current of entries) {
    const duration = days(current);
    if (duration === null || duration < 150 || duration > 380) continue;
    if (duration > 310 && (!ANNUAL_FORMS.includes(current.form) || current.fp !== 'FY')) continue;
    const previous = latest(entries.filter(entry => entry.tag === current.tag
      && entry.taxonomy === current.taxonomy && entry.unit === current.unit
      && entry.entityScope === current.entityScope && entry.accn === current.accn
      && entry.start === current.start && entry.end < current.end
      && days({ start: entry.end, end: current.end }) >= 60
      && days({ start: entry.end, end: current.end }) <= 125));
    if (!previous) continue;
    derived.push({ ...current, start: nextDay(previous.end), val: current.val - previous.val,
      derived: true, ...secDifferenceMetadata(current, previous) });
  }
  return derived;
}

function periodCandidates(entries, definition, type) {
  const candidates = type === 'quarterly' ? [...entries, ...quarterlyDifferences(entries, definition)] : entries;
  return candidates.filter(entry => {
    const duration = days(entry);
    if (duration === null) return false;
    if (type === 'annual') return ANNUAL_FORMS.includes(entry.form) && duration >= 330 && duration <= 380;
    if (type === 'ytd') return QUARTER_FORMS.includes(entry.form) && duration >= 150 && duration <= 310;
    return duration >= 60 && duration <= 125;
  });
}

function baseRecord(metricName, period, entry, periodIndex) {
  const definition = STANDARD_RAW_METRICS[metricName];
  const metadata = period.type === 'instant' || period.type === 'ytd'
    ? { fiscalYear: null, fiscalPeriod: null }
    : resolveSecPeriodMetadata(periodIndex, period.type, period.end, entry ? [entry] : []);
  return { metricName, periodType: period.type, periodStart: period.start, periodEnd: period.end,
    valueKind: definition.kind, entityScope: entry?.entityScope || definition.scope, unit: definition.unit,
    metricValue: null, availability: 'missing', reason: '직접 검증 가능한 동일 기간 SEC fact 없음',
    fiscalYear: metadata.fiscalYear, fiscalPeriod: metadata.fiscalPeriod, provenance: null };
}

function directRecord(metricName, period, entry, periodIndex) {
  const record = baseRecord(metricName, period, entry, periodIndex);
  if (!entry) return record;
  if (entry.entityScope !== STANDARD_RAW_METRICS[metricName].scope) {
    return { ...record, entityScope: STANDARD_RAW_METRICS[metricName].scope,
      availability: 'needs_review', reason: 'SEC fact의 연결/모회사 범위 불일치' };
  }
  const refs = (entry.sourceRefs || [secSourceReference(entry)])
    .map(ref => ({ ...ref, entity_scope: entry.entityScope, scope_basis: scopeBasis }));
  const primary = refs[0];
  return { ...record, metricValue: entry.val, availability: 'available', reason: null,
    provenance: { metricValue: entry.val, secTag: primary.tag, form: primary.form,
      accessionNumber: primary.accession, filedDate: primary.filed, sourceStart: primary.start,
      sourceEnd: primary.end, unit: entry.unit, calculationType: entry.calculationType || 'direct',
      sourceRefs: refs, calculationDetails: { ...(entry.calculationDetails || {}),
        entityScope: entry.entityScope, scopeBasis,
        ...(metricName === 'shares_outstanding' ? { shareBasis: entry.taxonomy === 'dei'
          ? 'cover_page_actual_date' : 'actual_point_in_time' } : {}) } } };
}

/** 순이익은 ProfitLoss만 사용한다. parent NetIncomeLoss/기존 net_income을 EBIT 입력으로 쓰지 않는다. */
export function deriveStandardMetric(metricName, period, inputs) {
  const expected = metricName === 'ebit'
    ? ['consolidated_net_income','income_tax_expense','interest_expense']
    : metricName === 'ebitda' ? ['ebit','depreciation_and_amortization'] : null;
  if (!expected) throw new Error('지원하지 않는 SEC 파생 지표입니다.');
  const record = baseRecord(metricName, period, null, new Map());
  if (!Array.isArray(inputs) || inputs.length !== expected.length
    || inputs.some((input, index) => input?.metricName !== expected[index])) return record;
  if (inputs.some(input => input?.availability !== 'available' || !input.provenance)) return record;
  const first = inputs[0];
  const aligned = inputs.every(input => input.periodStart === period.start && input.periodEnd === period.end
    && input.periodType === period.type && input.entityScope === 'consolidated' && input.unit === 'USD');
  // 제출 버전이 다른 수치를 섞지 않는다. 파생 입력의 전체 원본 accession도 검사한다.
  const refs = inputs.flatMap(input => input.provenance.sourceRefs);
  const accessions = new Set(refs.map(ref => ref.accession));
  if (!aligned || accessions.size !== 1 || accessions.has(null)) return { ...record,
    availability: 'needs_review', reason: '입력 기간/연결 범위/단위/공시 버전 불일치' };
  const value = inputs.reduce((sum, input) => sum + input.metricValue, 0);
  if (!Number.isFinite(value)) return { ...record, availability: 'needs_review', reason: '계산 결과가 유한수가 아님' };
  const formula = metricName === 'ebit'
    ? 'consolidated_net_income + income_tax_expense + interest_expense'
    : 'ebit + depreciation_and_amortization';
  return { ...record, metricValue: value, availability: 'available', reason: null,
    fiscalYear: first.fiscalYear, fiscalPeriod: first.fiscalPeriod,
    provenance: { metricValue: value, secTag: null, form: refs[0].form,
      accessionNumber: refs[0].accession, filedDate: refs.map(ref => ref.filed).sort().at(-1),
      sourceStart: period.start, sourceEnd: period.end, unit: 'USD', calculationType: 'derived',
      sourceRefs: inputs.flatMap(input => input.provenance.sourceRefs.map(ref => ({ ...ref,
        input_metric: input.metricName, input_value: input.metricValue,
        input_calculation_type: input.provenance.calculationType }))),
      calculationDetails: { formula, entityScope: 'consolidated', scopeBasis,
        inputs: inputs.map(input => ({ metric: input.metricName, value: input.metricValue,
          calculationType: input.provenance.calculationType,
          calculationDetails: input.provenance.calculationDetails })) } } };
}

/** 네트워크/DB 의존성 없는 순수 추출기다. 동일 sync의 이미 다운로드된 facts 객체만 받는다. */
export function extractStandardRawMetrics(facts, { minimumYear = new Date().getUTCFullYear() - 10,
  financialPeriods = [] } = {}) {
  const sets = Object.fromEntries(Object.entries(STANDARD_RAW_METRICS)
    .map(([name, definition]) => [name, collect(facts, definition)]));
  // raw가 없는 회사도 기존 표준 재무의 기간을 이용해 명시적 NULL을 남긴다. 달력 FY/Q 역산은 하지 않는다.
  const anchors = collect(facts, { unit: 'USD', scope: 'consolidated',
    tags: ['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','NetIncomeLoss',
      'NetCashProvidedByUsedInOperatingActivities','InterestIncomeExpenseNet'] });
  const periodIndex = buildSecPeriodIndex({ ...sets, anchors });
  const records = [];
  const eligible = entries => entries.filter(entry => Number(entry.end.slice(0, 4)) >= minimumYear);
  const pointNames = Object.keys(STANDARD_RAW_METRICS).filter(name => STANDARD_RAW_METRICS[name].kind === 'point_in_time');
  // 재무 기간 말과 DEI cover-page 실제 날짜는 서로 다른 보존 창이다.
  // DB의 기존 10FY/40Q를 명시적으로 받으면 원문이 없는 날짜도 NULL로 남겨 보존/누락을 구분한다.
  const protectedDates = ['annual','quarterly'].flatMap(type => financialPeriods
    .filter(period => period.period_type === type && validDate(period.fiscal_period_end))
    .map(period => period.fiscal_period_end).sort().slice(-(type === 'annual' ? 10 : 40)));
  const financialDates = [...new Set(pointNames.flatMap(name => eligible(sets[name])
    .filter(entry => !entry.start && entry.taxonomy !== 'dei').map(entry => entry.end)))].sort().slice(-60);
  const deiDates = eligible(sets.shares_outstanding).filter(entry => !entry.start && entry.taxonomy === 'dei')
    .map(entry => entry.end).sort();
  const pointDates = [...new Set([...financialDates, ...protectedDates, ...[...new Set(deiDates)].slice(-60)])].sort();
  for (const end of pointDates) for (const name of pointNames) records.push(directRecord(name,
    { type: 'instant', start: '', end }, latest(sets[name].filter(entry => !entry.start && entry.end === end)), periodIndex));
  const periodNames = Object.keys(STANDARD_RAW_METRICS).filter(name => !pointNames.includes(name));
  for (const type of ['annual','quarterly','ytd']) {
    const candidates = Object.fromEntries(periodNames.map(name => [name,
      eligible(periodCandidates(sets[name], STANDARD_RAW_METRICS[name], type))]));
    const anchorCandidates = eligible(periodCandidates(anchors, { kind: 'period' }, type));
    const all = [...Object.values(candidates).flat(), ...anchorCandidates];
    const ends = [...new Set(all.map(entry => entry.end))].sort().slice(-(type === 'annual' ? 10 : 40));
    for (const end of ends) {
      // 동일 end의 서로 다른 start는 별도 key다. 애매한 기간끼리 파생 합산하지 않는다.
      const starts = [...new Set(all.filter(entry => entry.end === end).map(entry => entry.start))].sort();
      for (const start of starts) {
        const period = { type, start, end }, selected = new Map();
        for (const name of periodNames.filter(name => STANDARD_RAW_METRICS[name].tags.length)) {
          const entry = type === 'ytd' && STANDARD_RAW_METRICS[name].kind === 'period_average' ? null
            : latest(candidates[name].filter(entry => entry.end === end && entry.start === start));
          const record = directRecord(name, period, entry, periodIndex);
          if (type === 'ytd' && STANDARD_RAW_METRICS[name].kind === 'period_average') {
            record.reason = '누적 평균 주식 수는 standalone 분기 값이 아니므로 저장하지 않음';
          }
          selected.set(name, record);
        }
        selected.set('ebit', deriveStandardMetric('ebit', period,
          ['consolidated_net_income','income_tax_expense','interest_expense'].map(name => selected.get(name))));
        selected.set('ebitda', deriveStandardMetric('ebitda', period,
          ['ebit','depreciation_and_amortization'].map(name => selected.get(name))));
        records.push(...selected.values());
      }
    }
  }
  return records;
}
