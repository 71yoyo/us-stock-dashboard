import { analysisProfileFor } from './company-classification.js';
import { querySpecializedMetrics, validateSpecializedQuery } from './specialized-metric-query.js';

const metrics = ['FFO', 'NORMALIZED_FFO', 'AFFO'];
const scopes = ['quarterly', 'annual', 'ytd'];
const bases = ['total', 'per_share'];
const shares = ['not_applicable', 'basic', 'diluted'];
const parameters = ['metric', 'scope', 'basis', 'shareBasis', 'start', 'end'];

// 모든 기준을 명시하도록 해 실수로 전체 dataset을 공개하지 않는다. 서비스의 날짜 검증도 재사용한다.
export function parseSpecializedHttpQuery(ticker, searchParams) {
  const input = {};
  for (const [key, value] of searchParams) {
    if (!parameters.includes(key) || Object.hasOwn(input, key)) {
      throw new Error('지원하지 않거나 중복된 조회 조건입니다.');
    }
    input[key] = value;
  }
  for (const [key, allowed] of [['metric', metrics], ['scope', scopes], ['basis', bases], ['shareBasis', shares]]) {
    if (!allowed.includes(input[key])) throw new Error(`${key}에 지원되는 기준을 명시해 주세요.`);
  }
  // 저장된 총액은 common(not_applicable) 또는 diluted이다. 기본 주식 수 총액을 합성하지 않는다.
  if (input.basis === 'total' && input.shareBasis === 'basic') {
    throw new Error('총액은 not_applicable 또는 diluted 기준을 사용해 주세요.');
  }
  return validateSpecializedQuery({ ticker, metricCode: input.metric, periodScope: input.scope,
    valueBasis: input.basis, shareBasis: input.shareBasis,
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined ? { end: input.end } : {}) });
}

// 원문/전체 provenance는 공개 series에서 제외한다. 값·검증상태·정의 경계는 그대로 보존한다.
export function serializeSpecializedSeries(series, analysisProfile) {
  const data = series.data.map(row => ({ recordKey: row.recordKey, fiscalYear: row.fiscalYear,
    fiscalPeriod: row.fiscalPeriod, periodStart: row.periodStart, periodEnd: row.periodEnd,
    value: row.value, unit: row.unit, definitionVersion: row.definitionVersion,
    definitionOwner: row.definitionOwner, attributionBasis: row.attributionBasis,
    validationStatus: row.validationStatus,
    sourceSummary: row.sourceSummary || { count: row.provenance.length,
      types: [...new Set(row.provenance.map(source => source.type))].sort() } }));
  const units = [...new Set(data.map(row => row.unit))];
  return { ticker: series.ticker, analysisProfile, metric: series.metric, scope: series.scope,
    basis: series.basis, shareBasis: series.shareBasis, unit: units.length === 1 ? units[0] : null,
    sourcePolicy: series.sourcePolicy, dateFilter: series.dateFilter,
    available: data.length > 0, availability: data.length ? 'stored' : 'no_stored_data',
    economicContinuityAssumed: false, data, definitionBoundaries: series.definitionBoundaries };
}

// 프로필 판정 때문에 ingestion이나 동기화를 실행하지 않는다. 회사가 존재해도 미보유 값은 빈 배열이다.
export async function readSpecializedHttpSeries(environment, query) {
  // 회사 존재와 저장 분류를 한 번에 읽되 기존 순수 판정 함수를 공유해 Override/stale 의미를 보존한다.
  const company = await environment.DB.prepare(`SELECT c.ticker,c.sector,c.industry,c.cik,
    p.ticker AS classification_ticker,p.rule_version,p.source_sector,p.source_industry,
    p.manual_override,p.manual_override_reason FROM companies c
    LEFT JOIN company_classification p ON p.ticker=c.ticker WHERE c.ticker=?`)
    .bind(query.ticker).first();
  if (!company) return null;
  const analysisProfile = analysisProfileFor(company, company.classification_ticker ? company : null);
  const series = await querySpecializedMetrics(environment.DB, query, { sourceSummaryOnly: true });
  return serializeSpecializedSeries(series, analysisProfile);
}
