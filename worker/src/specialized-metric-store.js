import { assertMetricRecord, metricRecordKey } from './specialized-metrics.js';

const definitionColumns = ['metric_code', 'definition_owner', 'definition_version', 'display_name',
  'profile', 'metric_family', 'default_unit', 'definition_source', 'definition_notes'];
const valueColumns = ['ticker', 'metric_code', 'definition_owner', 'definition_version', 'period_scope',
  'period_start', 'period_end', 'period_label', 'fiscal_year', 'fiscal_period', 'value_basis', 'share_basis',
  'attribution_basis', 'raw_value', 'raw_unit', 'raw_unit_multiplier', 'canonical_value', 'canonical_unit'];
const sourceColumns = ['source_type', 'source_url', 'accession_number', 'exhibit', 'document_name',
  'filed_at', 'published_at', 'table_title', 'section', 'page_number', 'source_hash', 'retrieved_at'];
const placeholders = columns => columns.map(() => '?').join(',');

// 호출자가 제공하는 D1 호환 DB만 사용한다. Worker 라우트·예약 작업에는 연결하지 않는다.
export async function saveSpecializedMetrics(DB, result) {
  if (result.status !== 'parsed' || !result.records?.length) throw new Error('검토/실패 결과는 저장할 수 없습니다.');
  const statements = [];
  const keys = new Set();
  const definitions = new Map();
  for (const definition of result.definitions) {
    if (definitionColumns.some(key => typeof definition[key] !== 'string' || !definition[key])) throw new Error('지표 정의 누락');
    const key = [definition.metric_code, definition.definition_owner, definition.definition_version].join('|');
    if (definitions.has(key)) throw new Error('중복 지표 정의');
    definitions.set(key, definition);
    const existing = await DB.prepare(`SELECT * FROM company_metric_definitions
      WHERE metric_code=? AND definition_owner=? AND definition_version=?`)
      .bind(definition.metric_code, definition.definition_owner, definition.definition_version).first();
    if (existing && definitionColumns.some(column => existing[column] !== definition[column])) throw new Error('동일 버전의 정의 변경 금지');
    statements.push(DB.prepare(`INSERT INTO company_metric_definitions (${definitionColumns.join(',')})
      VALUES (${placeholders(definitionColumns)}) ON CONFLICT DO NOTHING`).bind(...definitionColumns.map(column => definition[column])));
  }
  for (const record of result.records) {
    assertMetricRecord(record);
    if (!['parsed', 'validated'].includes(record.validation_status)) throw new Error('검토/거절 값 자동 저장 금지');
    if (!definitions.has([record.metric_code, record.definition_owner, record.definition_version].join('|'))) throw new Error('연결된 정의 없음');
    const key = metricRecordKey(record);
    if (keys.has(key)) throw new Error('중복 값');
    keys.add(key);
    const existing = await DB.prepare('SELECT * FROM company_metric_values WHERE record_key=?').bind(key).first();
    if (existing && valueColumns.some(column => existing[column] !== record[column])) throw new Error('같은 record의 값 충돌: 검토 필요');
    // 값은 불변이며 재실행은 idempotent다. 검증 상태는 parsed→validated 승격만 허용한다.
    statements.push(DB.prepare(`INSERT INTO company_metric_values (record_key,${valueColumns.join(',')},validation_status,validation_json)
      VALUES (?,${placeholders(valueColumns)},?,?) ON CONFLICT(record_key) DO UPDATE SET
      validation_status=CASE WHEN excluded.validation_status='validated' THEN 'validated' ELSE company_metric_values.validation_status END,
      validation_json=CASE WHEN excluded.validation_status='validated' THEN excluded.validation_json ELSE company_metric_values.validation_json END`)
      .bind(key, ...valueColumns.map(column => record[column]), record.validation_status, JSON.stringify(record.validation || null)));
    for (const source of record.sources) {
      statements.push(DB.prepare(`INSERT INTO company_metric_sources (record_key,${sourceColumns.join(',')},source_metadata_json)
        VALUES (?,${placeholders(sourceColumns)},?) ON CONFLICT DO NOTHING`)
        .bind(key, ...sourceColumns.map(column => source[column] ?? null), JSON.stringify(source)));
    }
  }
  await DB.batch(statements);
  return { records: keys.size, definitions: definitions.size };
}

export async function readSpecializedMetrics(DB, ticker) {
  const { results: rows } = await DB.prepare('SELECT * FROM company_metric_values WHERE ticker=? ORDER BY record_key').bind(ticker).all();
  const { results: sources } = await DB.prepare(`SELECT s.* FROM company_metric_sources s
    JOIN company_metric_values v ON v.record_key=s.record_key WHERE v.ticker=? ORDER BY s.source_url,s.source_hash`).bind(ticker).all();
  return rows.map(row => ({ ...Object.fromEntries(valueColumns.map(key => [key, row[key]])),
    validation_status: row.validation_status, validation: JSON.parse(row.validation_json),
    sources: sources.filter(source => source.record_key === row.record_key).map(source => JSON.parse(source.source_metadata_json)) }));
}
