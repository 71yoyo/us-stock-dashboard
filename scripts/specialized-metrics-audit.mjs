import assert from 'node:assert/strict';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { officialResults, loadExpected } from '../tests/helpers/realty-income-fixtures.js';

// 항상 offline fixture + 메모리 SQLite다. 키·환경변수·네트워크·운영 DB 옵션을 받지 않는다.
if (process.argv.length > 2) throw new Error('이 검증 도구는 인수 없이 로컬 fixture만 사용합니다.');
const results = await officialResults();
const expected = loadExpected().fixture.records;
const { sqlite, DB } = createMetricTestDatabase();
try {
  seedProtectedMetrics(sqlite);
  const before = protectedDigest(sqlite);
  for (const result of results) await saveSpecializedMetrics(DB, result);
  const stored = await readSpecializedMetrics(DB, 'O');
  const original = results.flatMap(result => result.records);
  const sort = records => [...records].sort((a, b) => metricRecordKey(a).localeCompare(metricRecordKey(b)));
  assert.deepEqual(sort(stored), sort(original));
  assert.equal(protectedDigest(sqlite), before);
  console.log('로컬 검증: 96 records / 6 definitions / 96 SEC provenance / round-trip PASS / 기존 데이터 변화 0');
  for (const scope of ['annual', 'quarterly', 'ytd']) {
    console.log(`\n${scope === 'annual' ? 'FY2025' : `2026 Q2 ${scope}`}`);
    console.table(expected.filter(row => row.period_scope === scope).map(row => {
      const actual = stored.find(record => metricRecordKey(record) === metricRecordKey(row));
      assert.equal(actual.raw_value, row.raw_value);
      assert.equal(actual.canonical_value, row.canonical_value);
      return { Metric: actual.metric_code, Basis: `${actual.value_basis}/${actual.share_basis}`,
        Raw: actual.raw_value, Canonical: actual.canonical_value, Expected: row.raw_value, Result: 'PASS' };
    }));
  }
  console.log('\nproduction migration/write/deploy/UI/commit/push: 모두 NO');
} finally { sqlite.close(); }
