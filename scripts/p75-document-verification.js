import { metricRecordKey } from '../worker/src/specialized-metrics.js';

const definitionColumns = ['metric_code', 'definition_owner', 'definition_version', 'display_name',
  'profile', 'metric_family', 'default_unit', 'definition_source', 'definition_notes'];
const valueColumns = ['ticker', 'metric_code', 'definition_owner', 'definition_version', 'period_scope',
  'period_start', 'period_end', 'period_label', 'fiscal_year', 'fiscal_period', 'value_basis', 'share_basis',
  'attribution_basis', 'raw_value', 'raw_unit', 'raw_unit_multiplier', 'canonical_value', 'canonical_unit'];

// 재저장을 검증으로 사용하지 않는다. 문서 값·정의·출처를 실제 SELECT로 즉시 대조한다.
export async function verifyDocument(DB, document) {
  if (!document.records?.length || document.records.length > 100) throw new Error('문서 검증 범위 오류');
  const keys = document.records.map(metricRecordKey), slots = keys.map(() => '?').join(',');
  const definitions = (await DB.prepare('SELECT * FROM company_metric_definitions').all()).results;
  const values = (await DB.prepare(`SELECT * FROM company_metric_values WHERE record_key IN (${slots})`).bind(...keys).all()).results;
  const sources = (await DB.prepare(`SELECT * FROM company_metric_sources WHERE record_key IN (${slots})`).bind(...keys).all()).results;
  for (const definition of document.definitions) {
    const stored = definitions.find(row => ['metric_code', 'definition_owner', 'definition_version'].every(key => row[key] === definition[key]));
    if (!stored || definitionColumns.some(key => stored[key] !== definition[key])) throw new Error('읽기 검증: 정의 불일치');
  }
  for (const record of document.records) {
    const key = metricRecordKey(record), stored = values.find(row => row.record_key === key);
    if (!stored || valueColumns.some(column => stored[column] !== record[column])) throw new Error('읽기 검증: 값 불일치');
    if (record.validation_status === 'validated' && (stored.validation_status !== 'validated'
      || JSON.stringify(JSON.parse(stored.validation_json)) !== JSON.stringify(record.validation))) throw new Error('읽기 검증: validated 근거 불일치');
    for (const source of record.sources) {
      const storedSource = sources.find(row => row.record_key === key && row.source_url === source.source_url && row.source_hash === source.source_hash);
      if (!storedSource || JSON.stringify(JSON.parse(storedSource.source_metadata_json)) !== JSON.stringify(source)) throw new Error('읽기 검증: 출처 불일치');
    }
  }
  return { records: document.records.length, readVerified: true, writes: 0 };
}
