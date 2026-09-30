import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historicalResults, historicalIds } from '../tests/helpers/realty-income-historical-fixtures.js';
import { officialResults } from '../tests/helpers/realty-income-fixtures.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';

// 네 legacy + 두 P3 fixture만 반복한다. URL/키/운영 DB/대량 backfill 인수는 받지 않는다.
if (process.argv.length > 2) throw new Error('인수 없는 offline 대표 6문서 검증만 지원합니다.');
const legacy = await historicalResults(), modern = await officialResults();
const { sqlite, DB } = createMetricTestDatabase(false);
const sort = records => [...records].sort((a, b) => metricRecordKey(a).localeCompare(metricRecordKey(b)));
try {
  seedProtectedMetrics(sqlite);
  const before = protectedDigest(sqlite);
  // 기존 0018만 적용하며, protected row가 있던 DB에서도 숫자/분류를 보존하는지 확인한다.
  sqlite.exec(readFileSync(new URL('../worker/migrations/0018_company_specialized_metrics.sql', import.meta.url), 'utf8'));
  assert.equal(protectedDigest(sqlite), before);
  for (const result of modern) await saveSpecializedMetrics(DB, result);
  const frozenP3 = await readSpecializedMetrics(DB, 'O');
  for (const result of legacy) { await saveSpecializedMetrics(DB, result); await saveSpecializedMetrics(DB, result); }
  const stored = await readSpecializedMetrics(DB, 'O');
  assert.deepEqual(sort(stored), sort([...frozenP3, ...legacy.flatMap(result => result.records)]));
  assert.deepEqual(sort(stored.filter(row => row.definition_version.startsWith('EX99.1-'))), sort(frozenP3));
  assert.equal(protectedDigest(sqlite), before);
  assert.equal(stored.length, 248);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n, 248);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 14);
  console.table(legacy.map((result, index) => ({ 문서: historicalIds[index], 형식: result.format,
    records: result.records.length, validated: result.records.filter(row => row.validation_status === 'validated').length,
    parsed: result.records.filter(row => row.validation_status === 'parsed').length,
    미공시: result.availability.map(row => `${row.metric_code}/${row.value_basis || '전체'}`).join(', ') })));
  console.log('대표 6문서: 248 records / 14 definitions (legacy 8 + P3 6) / 248 provenance');
  console.log('112 validated (legacy 76 + P3 36) / 136 parsed / 자동 검증 승격 없음');
  console.log('0018 Fresh(test)/Existing(audit), round-trip, idempotent, P3 보존: PASS / 보호 numeric·분류 변화 0');
  console.log('production migration/write/Worker·Pages deploy/UI/commit/push/전체 backfill: 모두 NO');
} finally { sqlite.close(); }
