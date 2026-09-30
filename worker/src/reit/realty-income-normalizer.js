import { assertMetricRecord, metricRecordKey } from '../specialized-metrics.js';
import { evidence, HISTORICAL_DOCUMENTS } from './realty-income-document-formats.js';

const owner = 'CIK0000726728';
const sourceAt = index => HISTORICAL_DOCUMENTS[index].url;
// 정의 버전은 레이아웃이 아니라 FFO 범위·AFFO 조정 시작점·Normalized FFO 제외항목을 따른다.
const semantics = {
  'FFO-REAL-ESTATE-V1': ['FFO', sourceAt(0), '부동산 자산 손상을 가산하는 NAREIT FFO 공시 정의.'],
  'FFO-DEPRECIABLE-V1': ['FFO', sourceAt(1), '상각 가능한 부동산 자산 손상을 가산하는 Nareit FFO 공시 정의.'],
  'NFFO-VEREIT-MERGER-V1': ['NORMALIZED_FFO', sourceAt(2), 'VEREIT 예정 합병 관련 비용을 제외하는 공시 정의.'],
  'NFFO-MERGER-INTEGRATION-V1': ['NORMALIZED_FFO', sourceAt(3), '합병 및 통합 관련 비용을 제외하는 공시 정의.'],
  'AFFO-FFO-REAL-ESTATE-V1': ['AFFO', sourceAt(0), '기존 부동산 손상 FFO를 고유 수익/비용으로 조정.'],
  'AFFO-FFO-DEPRECIABLE-V1': ['AFFO', sourceAt(1), '상각 가능한 부동산 손상 FFO를 고유 수익/비용으로 조정.'],
  'AFFO-NFFO-VEREIT-V1': ['AFFO', sourceAt(2), 'VEREIT 비용 제외 Normalized FFO를 시작점으로 고유 항목 조정.'],
  'AFFO-NFFO-INTEGRATION-V1': ['AFFO', sourceAt(3), '합병/통합 비용 제외 Normalized FFO를 시작점으로 고유 항목 조정.']
};

// 기존 정의의 불변 metadata를 재사용한다. 문서별 실제 문구는 각 source에 별도로 보존한다.
export function historicalDefinition(version) {
  evidence(semantics[version], 'DEFINITION_UNKNOWN', '등록되지 않은 기존 의미 버전입니다.');
  const [metric, definitionSource, notes] = semantics[version];
  return { metric_code:metric, definition_owner:owner, definition_version:version, display_name:metric,
    profile:'REIT', metric_family:'real_estate_cash_earnings', default_unit:'USD', definition_source:definitionSource,
    definition_notes:`${notes} 실제 조정항목은 각 provenance에 보존하며 연도 간 자동 비교 가능성을 보장하지 않는다.` };
}

export function historicalDefinitions(excerpt, tables) {
  const text = [...excerpt.pages, ...(excerpt.definition_excerpts || [])].map(page => page.text).join('\n').replace(/\s+/g, ' ');
  evidence(/FFO adjusted for unique revenue and expense items/i.test(text), 'DEFINITION_UNKNOWN', 'AFFO 정의 근거가 없습니다.');
  const depreciable = /impairments of depreciable real estate assets/.test(text);
  evidence(depreciable || /impairments of real estate assets/.test(text), 'DEFINITION_UNKNOWN', 'FFO 손상 범위 근거가 없습니다.');
  const versions = { FFO: depreciable ? 'FFO-DEPRECIABLE-V1' : 'FFO-REAL-ESTATE-V1',
    AFFO: depreciable ? 'AFFO-FFO-DEPRECIABLE-V1' : 'AFFO-FFO-REAL-ESTATE-V1' };
  if (tables.normalized) {
    if (tables.structural_strategy) {
      // 같은 비용 범위로 이미 승인한 표현만 재사용한다. 새로운 issuer/조정 범위는 P5C-B로 남긴다.
      const approvedMeaning = /FFO excluding merger and integration-related costs(?: (?:related to our Mergers with VEREIT|associated with our merger with VEREIT))?\./i.test(text);
      evidence(approvedMeaning, 'DEFINITION_REVIEW', '구조는 읽을 수 있으나 Normalized FFO 비용 제외 범위의 정의 검토가 필요합니다.');
    }
    const vereit = /FFO excluding merger-related costs related to our proposed merger with VEREIT/.test(text);
    const integration = /FFO excluding merger and integration-related costs/.test(text);
    evidence(vereit !== integration && /Normalized FFO available to common stockholders/.test(tables.affo.text),
      'DEFINITION_UNKNOWN', 'Normalized FFO 정의/실제 AFFO 시작점이 모호합니다.');
    versions.NORMALIZED_FFO = vereit ? 'NFFO-VEREIT-MERGER-V1' : 'NFFO-MERGER-INTEGRATION-V1';
    versions.AFFO = vereit ? 'AFFO-NFFO-VEREIT-V1' : 'AFFO-NFFO-INTEGRATION-V1';
  }
  return Object.values(versions).map(historicalDefinition);
}

// PDF adapter는 중간값만 만든다. 단위/키/상태/출처를 DB 계약으로 만드는 경로는 하나다.
export function normalizeHistoricalMetrics({ observations, definitions, source, format, inputHash, availability, definitionEvidence, structuralFeatures }) {
  const keys = new Set();
  const records = observations.map(observation => {
    const definition = definitions.find(row => row.metric_code === observation.metric_code);
    evidence(definition, 'DEFINITION_UNKNOWN', '관측값에 대응하는 정의가 없습니다.');
    const { unit, page, row_label, share_disclosure, ...value } = observation;
    const perShare = value.value_basis === 'per_share';
    evidence(unit === 'USD thousand' || unit === 'USD/share', 'UNIT_UNKNOWN', '근거 없는 단위는 정규화하지 않습니다.');
    evidence(perShare === (unit === 'USD/share'), 'UNIT_UNKNOWN', '총액/주당값 단위가 다릅니다.');
    const multiplier = perShare ? 1 : 1000;
    const record = { ticker: 'O', ...value, definition_owner: owner, definition_version: definition.definition_version,
      raw_unit: unit, raw_unit_multiplier: multiplier, canonical_value: value.raw_value * multiplier,
      canonical_unit: perShare ? 'USD/share' : 'USD', validation_status: 'parsed', validation: null,
      sources: [{ ...source, input_hash: inputHash, format_id: format, extraction_method: 'pdf_text_no_ocr',
        table_title: page.text.split('\n')[0], section: row_label, page_number: page.page_number,
        weighted_share_count_raw_unit: /\(dollars in thousands\s*, except per share amounts\)|except per share and share count data/.test(page.text) ? 'shares' : 'shares thousand',
        weighted_share_count_usage: '출처만 보존. 총액/주당값 계산 또는 역산에 사용하지 않음.',
        share_disclosure, availability, definition_evidence: definitionEvidence,
        ...(structuralFeatures ? { structural_features:structuralFeatures,
          ...(perShare && ['basic_and_diluted_joint', 'joint_basic_diluted'].includes(share_disclosure) ? { source_basis:'joint_basic_diluted' } : {}) } : {}) }] };
    assertMetricRecord(record);
    const key = metricRecordKey(record);
    evidence(!keys.has(key), 'DUPLICATE_LABEL', '동일 지표/기간/basis가 중복됐습니다.');
    keys.add(key);
    return record;
  });
  return { status: 'parsed', format, definitions, records, availability, errors: [] };
}
