// 동일 지표의 총액과 주당값을 basis로 구분한다. 회사별 정의 버전은 서로 교환할 수 없다.
export const PERIOD_SCOPES = ['annual', 'quarterly', 'ytd', 'ttm'];
export const VALUE_BASES = ['total', 'per_share', 'percentage', 'ratio', 'count'];
export const VALIDATION_STATUSES = ['parsed', 'validated', 'needs_review', 'rejected'];
const required = (condition, message) => { if (!condition) throw new Error(message); };
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function metricRecordKey(record) {
  return ['ticker', 'metric_code', 'definition_owner', 'definition_version', 'period_scope',
    'period_start', 'period_end', 'value_basis', 'share_basis', 'attribution_basis']
    .map(key => record[key]).join('|');
}

export function assertMetricRecord(record) {
  for (const key of ['ticker', 'metric_code', 'definition_owner', 'definition_version', 'period_label',
    'fiscal_period', 'attribution_basis', 'raw_unit', 'canonical_unit']) {
    required(typeof record[key] === 'string' && record[key].length > 0 && !record[key].includes('|'), `${key} 누락/형식 오류`);
  }
  required(PERIOD_SCOPES.includes(record.period_scope), '기간 범위 오류');
  required(isoDate(record.period_start) && isoDate(record.period_end)
    && record.period_start <= record.period_end, '실제 기간 오류');
  required(Number.isInteger(record.fiscal_year), '회계연도 오류');
  required(VALUE_BASES.includes(record.value_basis), '값 기준 오류');
  required(['not_applicable', 'basic', 'diluted'].includes(record.share_basis), '주식 기준 오류');
  required(record.value_basis !== 'per_share' || ['basic', 'diluted'].includes(record.share_basis), '주당값의 basic/diluted 누락');
  required(Number.isFinite(record.raw_value) && Number.isFinite(record.canonical_value)
    && Number.isFinite(record.raw_unit_multiplier) && record.raw_unit_multiplier > 0, '숫자/단위 오류');
  required(record.canonical_value === record.raw_value * record.raw_unit_multiplier, '원값과 canonical 값 불일치');
  required(VALIDATION_STATUSES.includes(record.validation_status), '검증 상태 오류');
  required(record.validation_status !== 'validated' || (record.validation?.method === 'official_expected_fixture'
    && /^[a-f0-9]{64}$/.test(record.validation.fixture_hash)), 'validated 검증 근거 누락');
  required(Array.isArray(record.sources) && record.sources.length > 0, '출처 누락');
  for (const source of record.sources) {
    let url;
    try { url = new URL(source.source_url); }
    catch { throw new Error('출처 URL 형식 오류'); }
    required(url.protocol === 'https:' && !url.username && !url.password && !url.search, '출처 URL 형식 오류');
    for (const key of ['source_type', 'document_name', 'published_at', 'table_title', 'section', 'retrieved_at']) {
      required(typeof source[key] === 'string' && source[key].length > 0, `출처 ${key} 누락`);
    }
    required(/^[a-f0-9]{64}$/.test(source.source_hash), '원문 hash 오류');
  }
  return record;
}

// expected 숫자는 호출자가 테스트 fixture로 전달한다. 파서/운영 코드에는 공식 검증 숫자를 넣지 않는다.
export function validateAgainstOfficialExpected(records, fixture, fixtureHash) {
  required(/^[a-f0-9]{64}$/.test(fixtureHash), 'expected fixture hash 오류');
  const actual = new Map(records.map(record => [metricRecordKey(record), record]));
  required(actual.size === records.length, '중복 record');
  required(fixture.records.length > 0, 'expected fixture 없음');
  const verified = new Set();
  for (const expected of fixture.records) {
    const record = actual.get(metricRecordKey(expected));
    required(record, `공식 expected 기간/basis 누락: ${metricRecordKey(expected)}`);
    for (const [key, value] of Object.entries(expected)) {
      required(record[key] === value, `공식 expected 불일치: ${expected.metric_code} ${key}`);
    }
    verified.add(metricRecordKey(record));
  }
  return records.map(record => verified.has(metricRecordKey(record))
    ? { ...record, validation_status: 'validated', validation: { method: 'official_expected_fixture', fixture_hash: fixtureHash } }
    : { ...record });
}
