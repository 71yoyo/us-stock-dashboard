import assert from 'node:assert/strict';
import { p5aIds, p5aResults, inventoryFixture, readP5a } from '../tests/helpers/realty-income-p5a-fixtures.js';
import { historicalResults } from '../tests/helpers/realty-income-historical-fixtures.js';
import { officialResults } from '../tests/helpers/realty-income-fixtures.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { parseArchive } from './realty-income-inventory.mjs';
import { compareObservations } from './realty-income-comparison.mjs';

// network/운영 DB/전체 historical loop 인수를 받지 않는 고정 표본 audit다.
if (process.argv.length > 2) throw new Error('인수 없는 P5A 다섯 표본 offline audit만 허용합니다.');
const inventory = inventoryFixture(), entries = parseArchive(readP5a('archive-excerpt.html'));
assert.equal(entries.length, 48);
assert.equal(inventory.documents.length, 40);
assert.equal(inventory.documents.filter(row => row.status === 'SUPPORTED').length, 9);
assert.equal(inventory.documents.filter(row => row.status === 'UNKNOWN_FORMAT').length, 31);
assert.ok(inventory.excluded_documents.every(row => row.status === 'WRONG_ISSUER'));
const results = await p5aResults(), old = [...await officialResults(), ...await historicalResults()];
const compare = compareObservations(results[3].records, results[4].records);
assert.equal(compare.length, 24);
assert.ok(compare.every(row => row.delta === 0 && row.status === 'matching_comparative'));
const verified = [...results, ...old].flatMap(result => result.records.map(record => record.sources[0]));
for (const row of inventory.documents.filter(row => row.status === 'SUPPORTED')) {
  assert.ok(verified.some(source => source.source_url === row.source_url && source.format_id === row.format_detected));
}
const { sqlite, DB } = createMetricTestDatabase();
try {
  seedProtectedMetrics(sqlite); const beforeDigest = protectedDigest(sqlite);
  for (const result of old) await saveSpecializedMetrics(DB, result);
  const before = await readSpecializedMetrics(DB, 'O'), keys = new Set(before.map(metricRecordKey));
  assert.equal(before.length, 248);
  for (const result of results) { await saveSpecializedMetrics(DB, result); await saveSpecializedMetrics(DB, result); }
  const records = await readSpecializedMetrics(DB, 'O');
  assert.deepEqual(records.filter(record => keys.has(metricRecordKey(record))), before);
  assert.equal(records.length, 396);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 14);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n, 420);
  assert.equal(protectedDigest(sqlite), beforeDigest);
  console.table(results.map((result, index) => ({ 문서: p5aIds[index], format: result.format,
    records: result.records.length, validated: result.records.filter(row => row.validation_status === 'validated').length,
    parsed: result.records.filter(row => row.validation_status === 'parsed').length })));
  console.log('Inventory: 40 O quarterly / 9 SUPPORTED / 31 UNKNOWN_FORMAT / 6 WRONG_ISSUER 제외 / 2026 참고 2');
  console.log('추가 5표본: 172 observations / 86 validated / 86 parsed / 중복 비교값 24개 모두 일치');
  console.log('P3/P4 보존: 248 / 합계 396 unique records / 14 definitions / 420 provenance / 198 validated / 198 parsed');
  console.log('기존 financial/classification digest 변화 0 / schema 변경 0 / 자동 overwrite 없음');
  console.log('P5B READY: 읽기 전용 전체 조사 준비. UNKNOWN 31개의 지원 성공을 보증하는 의미가 아님.');
  console.log('production migration/write/deploy/UI/전체 backfill/commit/push 모두 NO');
} finally { sqlite.close(); }
