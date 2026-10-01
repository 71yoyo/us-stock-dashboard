import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertDisposable, rehearsalName, rehearsalId } from '../scripts/p75-prepare.mjs';
import { boundedRetry } from '../scripts/p75-policy.js';
import { semanticArtifact } from '../scripts/p75-artifact.mjs';
import { measuredDatabase } from '../scripts/p75-worker.js';
import { createMetricTestDatabase } from './helpers/specialized-metrics-db.js';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { officialResults } from './helpers/realty-income-fixtures.js';
import { verifyDocument } from '../scripts/p75-document-verification.js';

const valid = () => ({ name: rehearsalName, workers_dev: false,
  vars: { REHEARSAL_MARKER: 'P75_DISPOSABLE_ONLY', CONFIRM_DISPOSABLE: 'YES' },
  d1_databases: [{ binding: 'REHEARSAL_DB', database_id: rehearsalId, database_name: rehearsalName }] });

test('P7.5 config는 운영 binding/DB/불명확한 marker/공개 route를 거부한다', () => {
  assert.doesNotThrow(() => assertDisposable(valid()));
  for (const mutate of [config => config.d1_databases[0].database_id = '698ab9b8-4573-40c7-b119-d7b1d681abc8',
    config => config.d1_databases[0].binding = 'DB', config => config.vars.CONFIRM_DISPOSABLE = 'NO',
    config => config.vars.REHEARSAL_MARKER = '', config => config.workers_dev = true, config => config.routes = ['*']]) {
    const config = valid(); mutate(config); assert.throws(() => assertDisposable(config));
  }
});
test('P7.5 artifact 생성시각만 digest에서 제외하고 원문/값/검증상태는 유지한다', () => {
  const artifact = { datasetVersion: 'v1', parserCommit: 'abc', generatedAt: 'first',
    documents: [{ source_hash: 'first', records: [{ canonical_value: 0, validation_status: 'parsed' }] }], expected: {} };
  assert.deepEqual(semanticArtifact(artifact), semanticArtifact({ ...artifact, generatedAt: 'second' }));
  const changed = structuredClone(artifact); changed.documents[0].source_hash = 'second';
  assert.notDeepEqual(semanticArtifact(changed), semanticArtifact(artifact));
});
test('일시 과부하는 bounded backoff+jitter로 재시도하고 의미 오류는 즉시 종료한다', async () => {
  const delays = []; let calls = 0;
  assert.equal(await boundedRetry(() => { if (++calls < 3) throw new Error('overloaded'); return 'ok'; }, async ms => delays.push(ms), () => 0.5), 'ok');
  assert.deepEqual(delays, [250, 450]);
  for (const message of ['값 충돌', 'hash mismatch', 'lease loss', 'CHECK constraint failed', 'network: lease loss', 'overloaded: hash mismatch']) {
    calls = 0; await assert.rejects(() => boundedRetry(() => { calls++; throw new Error(message); }, async () => {}));
    assert.equal(calls, 1);
  }
  calls = 0; await assert.rejects(() => boundedRetry(() => { calls++; throw new Error('network'); }, async () => {})); assert.equal(calls, 3);
});
test('bulk preflight는 2회 조회로 줄여도 기존 정의·값 충돌 검사를 보존한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.prepare('INSERT INTO companies(ticker,name) VALUES(?,?)').run('O', 'P75 synthetic');
    const input = (await officialResults())[0];
    let reads = 0; const original = DB.prepare.bind(DB);
    DB.prepare = sql => { if (sql.startsWith('SELECT')) reads++; return original(sql); };
    await saveSpecializedMetrics(DB, input); assert.equal(reads, 2);
    const changed = structuredClone(input); changed.records[0].raw_value += 1;
    changed.records[0].canonical_value = changed.records[0].raw_value * changed.records[0].raw_unit_multiplier;
    await assert.rejects(() => saveSpecializedMetrics(DB, changed), /충돌/);
  } finally { sqlite.close(); }
});
test('실제 SQL CHECK guard는 만료된 owner의 전체 write batch를 rollback한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec(readFileSync('scripts/p75-test-schema.sql', 'utf8'));
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES('O','test'); INSERT INTO p75_leases VALUES('specialized','dataset','new',2,9999999999999)");
    const metrics = { sql: 0, rpc: 0, rows_read: 0, rows_written: 0, d1_duration_ms: 0 };
    const wrapped = measuredDatabase(DB, metrics, { lease: { dataset: 'dataset', owner: 'old', fence: 1 } });
    const input = (await officialResults())[0];
    await assert.rejects(() => saveSpecializedMetrics(wrapped, input), /CHECK/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_values').get().n, 0);
  } finally { sqlite.close(); }
});
test('문서 즉시 SELECT 검증은 쓰기 없이 값·정의·출처를 대조한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES('O','P75 test')");
    const input = (await officialResults())[0]; await saveSpecializedMetrics(DB, input);
    const before = sqlite.prepare('SELECT total_changes() n').get().n;
    assert.equal((await verifyDocument(DB, input)).readVerified, true);
    assert.equal(sqlite.prepare('SELECT total_changes() n').get().n, before);
    const changed = structuredClone(input); changed.records[0].canonical_value += 1;
    await assert.rejects(() => verifyDocument(DB, changed), /값 불일치/);
  } finally { sqlite.close(); }
});
test('121개 synthetic record preflight도 query 당 최대 100 bind를 지킨다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES('O','P75 synthetic')");
    const input = (await officialResults())[0];
    input.records = Array.from({ length: 121 }, (_, index) => ({ ...structuredClone(input.records[0]), attribution_basis: `synthetic_${index}` }));
    let reads = 0, maxBindings = 0; const original = DB.prepare.bind(DB);
    DB.prepare = sql => {
      const statement = original(sql), bind = statement.bind;
      if (sql.startsWith('SELECT')) {
        reads++; statement.bind = (...values) => { maxBindings = Math.max(maxBindings, values.length); return bind.call(statement, ...values); };
      }
      return statement;
    };
    await saveSpecializedMetrics(DB, input);
    assert.equal(reads, 3); assert.equal(maxBindings, 100);
  } finally { sqlite.close(); }
});
