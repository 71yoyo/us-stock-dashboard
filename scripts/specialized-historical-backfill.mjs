import assert from 'node:assert/strict';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { specializedSnapshot, stableData, hash } from './specialized-disposable-db.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const definitionKey = row => [row.metric_code, row.definition_owner, row.definition_version].join('|');
const sourceKey = row => [row.record_key, row.source_url, row.source_hash].join('|');
const columns = (sqlite, table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);

// 기존 저장 함수와 문서별 DB.batch를 그대로 사용한다. 영속 DB나 D1 환경을 이 도구에 전달할 수 없다.
export async function backfillHistorical(database, rows) {
  assert.ok(database.disposable === true && database.path === ':memory:', '폐기 가능한 메모리 SQLite만 허용합니다.');
  let accepted = 0;
  for (const row of rows) {
    assert.ok(['PARSED', 'VERIFIED_PARSED'].includes(row.final_status), `저장 승인되지 않은 문서: ${row.id}`);
    assert.ok(row.records.length > 0 && row.definitions.length > 0, `빈 문서: ${row.id}`);
    try { await saveSpecializedMetrics(database.DB, { status: 'parsed', definitions: row.definitions, records: row.records }); }
    catch (error) { throw new Error(`문서 ${row.id} 적재 실패: ${error.message}`, { cause: error }); }
    accepted++;
  }
  return { processed: rows.length, accepted, ...specializedSnapshot(database.sqlite) };
}

// 기대 row 수와 모든 의미 필드를 현재 parser output에서 계산한다. definition/값/출처 수를 하드코딩하지 않는다.
export function assertParserDbAgreement(sqlite, rows) {
  const definitions = new Map(), values = new Map(), sources = new Map();
  const definitionColumns = columns(sqlite, 'company_metric_definitions');
  const valueColumns = columns(sqlite, 'company_metric_values');
  const sourceColumns = columns(sqlite, 'company_metric_sources');
  let observations = 0;
  for (const document of rows) {
    for (const definition of document.definitions) {
      const key = definitionKey(definition);
      const selected = Object.fromEntries(definitionColumns.map(column => [column, definition[column]]));
      if (definitions.has(key)) assert.deepEqual(selected, definitions.get(key), '같은 definition identity의 의미 충돌');
      else definitions.set(key, selected);
    }
    for (const record of document.records) {
      observations++;
      const key = metricRecordKey(record);
      const selected = Object.fromEntries(valueColumns.map(column => [column, column === 'record_key' ? key
        : column === 'validation_json' ? record.validation || null : record[column]]));
      if (values.has(key)) {
        const existing = values.get(key);
        for (const column of valueColumns.filter(name => !['validation_status', 'validation_json'].includes(name))) {
          assert.deepEqual(selected[column], existing[column], `동일 identity의 parser 필드 충돌: ${column}`);
        }
        // 공시 expected 근거가 있는 기존 validated만 유지한다. parsed를 적재 이유만으로 승격하지 않는다.
        if (record.validation_status === 'validated') {
          existing.validation_status = selected.validation_status; existing.validation_json = selected.validation_json;
        }
      } else values.set(key, selected);
      for (const source of record.sources) {
        const selectedSource = Object.fromEntries(sourceColumns.map(column => [column, column === 'record_key' ? key
          : column === 'source_metadata_json' ? source : source[column] ?? null]));
        if (!sources.has(sourceKey(selectedSource))) sources.set(sourceKey(selectedSource), selectedSource);
      }
    }
  }
  const order = (map, key) => [...map.values()].sort((a, b) => compare(key(a), key(b)));
  const expected = { definitions: hash(stableData(order(definitions, definitionKey))),
    values: hash(stableData(order(values, row => row.record_key))),
    provenance: hash(stableData(order(sources, sourceKey))) };
  const actual = specializedSnapshot(sqlite);
  assert.deepEqual(actual.counts, { definitions: definitions.size, values: values.size, provenance: sources.size });
  assert.deepEqual(actual.digests, expected, 'parser와 저장 DB의 전체 의미 데이터 불일치');
  return { observations, uniqueValues: values.size, definitions: definitions.size, provenance: sources.size,
    validationStatuses: [...values.values()].reduce((counts, row) => {
      counts[row.validation_status] = (counts[row.validation_status] || 0) + 1; return counts;
    }, {}), semanticRoundTrip: true };
}
