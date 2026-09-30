import { metricRecordKey } from '../worker/src/specialized-metrics.js';

// 동일 canonical 의미만 대조한다. 정의/기간/basis가 다르면 같다고 합치지 않고 값의 자동 덮어쓰기도 하지 않는다.
export function compareObservations(original, comparative) {
  const previous = new Map(original.map(record => [metricRecordKey(record), record]));
  if (previous.size !== original.length || new Set(comparative.map(metricRecordKey)).size !== comparative.length) {
    throw new Error('입력 문서 안의 canonical 중복은 비교 전에 검토해야 합니다.');
  }
  return comparative.flatMap(record => {
    const key = metricRecordKey(record), before = previous.get(key);
    if (!before) return [];
    const equal = before.canonical_unit === record.canonical_unit && before.canonical_value === record.canonical_value;
    return [{ record_key: key, metric: record.metric_code, scope: record.period_scope,
      period_start: record.period_start, period_end: record.period_end, basis: record.value_basis, share_basis: record.share_basis,
      original_value: before.canonical_value, comparative_value: record.canonical_value,
      unit: record.canonical_unit, delta: record.canonical_unit === before.canonical_unit ? record.canonical_value - before.canonical_value : null,
      original_document: before.sources[0].source_url, comparative_document: record.sources[0].source_url,
      status: equal ? 'matching_comparative' : 'restated/comparative difference' }];
  });
}
