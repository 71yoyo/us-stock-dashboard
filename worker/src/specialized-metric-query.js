import { PERIOD_SCOPES, VALUE_BASES } from './specialized-metrics.js';

const requireQuery = (condition, message) => { if (!condition) throw new Error(message); };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// 공급원 재호출·보간·성장률 계산 없이 저장된 canonical 값만 읽는다. 모든 필터는 SQL bind를 사용한다.
export function validateSpecializedQuery(input) {
  requireQuery(input && typeof input === 'object' && !Array.isArray(input), '조회 조건을 객체로 입력해 주세요.');
  const allowed = ['ticker', 'metricCode', 'periodScope', 'valueBasis', 'shareBasis', 'start', 'end',
    'unit', 'definitionOwner', 'definitionVersion', 'attributionBasis', 'includeComparisons'];
  requireQuery(Object.keys(input).every(key => allowed.includes(key)), '지원하지 않는 조회 조건입니다.');
  requireQuery(typeof input.ticker === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(input.ticker), 'ticker 형식이 올바르지 않습니다.');
  requireQuery(typeof input.metricCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.metricCode), 'metricCode 형식이 올바르지 않습니다.');
  requireQuery(PERIOD_SCOPES.includes(input.periodScope), 'periodScope를 명시해 주세요.');
  requireQuery(VALUE_BASES.includes(input.valueBasis), 'valueBasis를 명시해 주세요.');
  requireQuery(['not_applicable', 'basic', 'diluted'].includes(input.shareBasis), 'shareBasis를 명시해 주세요.');
  requireQuery(input.valueBasis !== 'per_share' || input.shareBasis !== 'not_applicable', '주당값은 basic 또는 diluted 기준이 필요합니다.');
  for (const key of ['start', 'end']) requireQuery(input[key] === undefined || validDate(input[key]), `${key}는 실제 YYYY-MM-DD 날짜여야 합니다.`);
  requireQuery(!input.start || !input.end || input.start <= input.end, 'start가 end보다 늦습니다.');
  for (const key of ['unit', 'definitionOwner', 'definitionVersion', 'attributionBasis']) {
    requireQuery(input[key] === undefined || typeof input[key] === 'string' && input[key].length > 0
      && input[key].length <= 120 && !/[\x00-\x1f|]/.test(input[key]), `${key} 형식이 올바르지 않습니다.`);
  }
  requireQuery(input.includeComparisons === undefined || typeof input.includeComparisons === 'boolean', 'includeComparisons는 boolean이어야 합니다.');
  return { ...input, includeComparisons: input.includeComparisons ?? false };
}

const versionIdentity = row => [row.definitionOwner, row.definitionVersion, row.attributionBasis].join('|');
const periodIdentity = row => [row.periodStart, row.periodEnd, row.fiscalYear, row.fiscalPeriod].join('|');

// 같은 기간의 여러 정의도 숨기지 않는다. 경계는 식별 정보이며 경제적 동등성이나 성장 계산 근거가 아니다.
export function specializedDefinitionBoundaries(data) {
  const periods = new Map();
  for (const row of data) {
    const key = periodIdentity(row);
    if (!periods.has(key)) periods.set(key, { row, versions: new Map() });
    periods.get(key).versions.set(versionIdentity(row), {
      owner: row.definitionOwner, version: row.definitionVersion, attribution: row.attributionBasis
    });
  }
  const groups = [...periods.values()].sort((a, b) => a.row.periodEnd.localeCompare(b.row.periodEnd)
    || a.row.periodStart.localeCompare(b.row.periodStart));
  const boundaries = [];
  let previous = null;
  for (const group of groups) {
    const versions = [...group.versions.entries()].sort(([a], [b]) => a.localeCompare(b));
    const identity = versions.map(([key]) => key).join(';;');
    if (previous && identity !== previous.identity || !previous && versions.length > 1) boundaries.push({
      fiscalYear: group.row.fiscalYear, fiscalPeriod: group.row.fiscalPeriod,
      periodStart: group.row.periodStart, periodEnd: group.row.periodEnd,
      previousDefinitions: previous?.definitions || [], definitions: versions.map(([, value]) => value),
      ambiguousPeriod: versions.length > 1,
      kind: JSON.stringify(versions.map(([, row]) => [row.owner, row.version]))
        === JSON.stringify((previous?.definitions || []).map(row => [row.owner, row.version])) ? 'attribution' : 'definition'
    });
    previous = { identity, definitions: versions.map(([, value]) => value) };
  }
  return boundaries;
}

export async function querySpecializedMetrics(DB, input) {
  const query = validateSpecializedQuery(input);
  const clauses = ['v.ticker=?', 'v.metric_code=?', 'v.period_scope=?', 'v.value_basis=?', 'v.share_basis=?'];
  const bindings = [query.ticker, query.metricCode, query.periodScope, query.valueBasis, query.shareBasis];
  for (const [key, column, operator] of [['start', 'period_end', '>='], ['end', 'period_end', '<='],
    ['unit', 'canonical_unit', '='], ['definitionOwner', 'definition_owner', '='], ['definitionVersion', 'definition_version', '='],
    ['attributionBasis', 'attribution_basis', '=']]) {
    if (query[key] !== undefined) { clauses.push(`v.${column}${operator}?`); bindings.push(query[key]); }
  }
  // 기본 series는 해당 공시기간의 직접 값이다. 다음 연도 비교 열의 다른 definition을 최신값으로 덮어쓰지 않는다.
  // 비교 열도 전량 DB에 남으며 includeComparisons=true로 별도 조회한다. 원문 fiscal metadata 없는 값은 추측하지 않는다.
  if (!query.includeComparisons) clauses.push(`EXISTS (SELECT 1 FROM company_metric_sources own
    WHERE own.record_key=v.record_key AND json_extract(own.source_metadata_json,'$.fiscal_year')=v.fiscal_year
    AND (v.period_scope='annual' OR json_extract(own.source_metadata_json,'$.fiscal_period')=v.fiscal_period))`);
  const where = clauses.join(' AND ');
  const { results: values } = await DB.prepare(`SELECT v.* FROM company_metric_values v WHERE ${where}
    ORDER BY v.period_end,v.period_start,v.fiscal_year,v.fiscal_period,v.definition_owner,v.definition_version,v.record_key`)
    .bind(...bindings).all();
  // 원문 excerpt 등 큰 JSON은 DB에 그대로 보존한다. 조회 응답에 필요한 6개 metadata만 SQL에서 추출해
  // Worker의 불필요한 JSON 전송/파싱 CPU를 줄인다. 객체가 아닌 손상 metadata는 기존 오류 검사를 유지한다.
  const { results: sources } = await DB.prepare(`SELECT s.record_key,s.source_type,s.source_url,s.source_hash,
    s.document_name,s.section,s.page_number,
    CASE WHEN json_type(s.source_metadata_json)='object' THEN json_object(
      'physical_page',json_extract(s.source_metadata_json,'$.physical_page'),
      'printed_page',json_extract(s.source_metadata_json,'$.printed_page'),
      'fiscal_year',json_extract(s.source_metadata_json,'$.fiscal_year'),
      'fiscal_period',json_extract(s.source_metadata_json,'$.fiscal_period'),
      'unit_measurement',json_extract(s.source_metadata_json,'$.unit_measurement'),
      'unit_qualifier',json_extract(s.source_metadata_json,'$.unit_qualifier'))
    ELSE s.source_metadata_json END AS source_metadata_json FROM company_metric_sources s
    JOIN company_metric_values v ON v.record_key=s.record_key WHERE ${where}
    ORDER BY s.record_key,s.source_url,s.source_hash`).bind(...bindings).all();
  const byKey = new Map();
  for (const source of sources) {
    let metadata;
    try { metadata = JSON.parse(source.source_metadata_json); }
    catch { throw new Error('저장된 출처 metadata가 손상됐습니다. 저장 무결성을 확인해 주세요.'); }
    requireQuery(metadata && typeof metadata === 'object' && !Array.isArray(metadata),
      '저장된 출처 metadata가 객체가 아닙니다. 저장 무결성을 확인해 주세요.');
    if (!byKey.has(source.record_key)) byKey.set(source.record_key, []);
    byKey.get(source.record_key).push({ type: source.source_type, url: source.source_url, hash: source.source_hash,
      document: source.document_name, section: source.section, page: source.page_number,
      physicalPage: metadata.physical_page ?? source.page_number, printedPage: metadata.printed_page ?? null,
      sourceFiscalYear: metadata.fiscal_year ?? null, sourceFiscalPeriod: metadata.fiscal_period ?? null,
      rawUnitMeasurement: metadata.unit_measurement ?? null, unitQualifier: metadata.unit_qualifier ?? null });
  }
  const data = values.map(row => ({ recordKey: row.record_key, fiscalYear: row.fiscal_year, fiscalPeriod: row.fiscal_period,
    periodStart: row.period_start, periodEnd: row.period_end, value: row.canonical_value, unit: row.canonical_unit,
    definitionOwner: row.definition_owner, definitionVersion: row.definition_version, attributionBasis: row.attribution_basis,
    validationStatus: row.validation_status, rawValue: row.raw_value, rawUnit: row.raw_unit, rawMultiplier: row.raw_unit_multiplier,
    provenance: byKey.get(row.record_key) || [] }));
  return { ticker: query.ticker, metric: query.metricCode, scope: query.periodScope, basis: query.valueBasis,
    shareBasis: query.shareBasis, sourcePolicy: query.includeComparisons ? 'all_disclosures' : 'primary_period_disclosure',
    dateFilter: 'periodEnd inclusive', data, definitionBoundaries: specializedDefinitionBoundaries(data),
    economicContinuityAssumed: false };
}
