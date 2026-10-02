import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../scripts/p9a-preview-worker.js';
import { DISPOSABLE, previewConfig, verifySeries, seriesParameters, collectCpu } from '../scripts/p9a-audit-core.mjs';
import { SERIES, semanticHash } from '../scripts/p77-gate-core.mjs';

const configInput = () => ({ workerName: 'us-stock-p9a-gate-test', authHash: 'a'.repeat(64), expiresAt: Date.now() + 60000 });
test('P9A preview는 disposable DB만 연결하고 Cron/Secret/production traffic 경로 없음', () => {
  const config = previewConfig(configInput());
  assert.equal(config.d1_databases, undefined); assert.equal(config.triggers, undefined); assert.equal(config.routes, undefined);
  assert.equal(config.previews.d1_databases[0].database_id, DISPOSABLE.id);
  assert.equal(config.previews.d1_databases[0].binding, 'DB');
  assert.equal(config.previews.observability.head_sampling_rate, 1);
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, true);
});
for (const change of [{ workerName: 'us-stock-dashboard-api' }, { expiresAt: NaN },
  { expiresAt: 1 }, { expiresAt: Date.now() + 7200000 }, { authHash: 'invalid' }]) {
  test(`P9A preview config guard ${Object.keys(change)[0]} ${String(Object.values(change)[0])}`, () => {
    assert.throws(() => previewConfig({ ...configInput(), ...change }));
  });
}
test('P9A 승인 9 series query mapping은 기준 변경 없음', () => {
  for (const series of SERIES) assert.deepEqual(seriesParameters(series), { metric: series.query.metricCode,
    scope: series.query.periodScope, basis: series.query.valueBasis, shareBasis: series.query.shareBasis });
});
test('P9A preview 만료/production DB/쓰기 경로는 DB 접근 이전 거부', async () => {
  const token = 'a'.repeat(64), env = { DB: { prepare() { throw new Error('DB 접근 금지'); } },
    P9A_PRIVATE_ONLY: 'YES', P9A_DB_ID: DISPOSABLE.id, P9A_EXPIRES_AT: String(Date.now() + 60000),
    P9A_AUTH_HASH: createHash('sha256').update(token).digest('hex') };
  const url = 'https://private.test/api/companies/O/specialized-metrics';
  for (const [request, environment] of [[new Request(url), env],
    [new Request(url, { headers: { Authorization: `Bearer ${token}` } }), { ...env, P9A_EXPIRES_AT: 'NaN' }],
    [new Request(url), { ...env, P9A_DB_ID: '698ab9b8-4573-40c7-b119-d7b1d681abc8' }],
    [new Request(url, { method: 'POST' }), env], [new Request('https://private.test/api/sync'), env]]) {
    assert.equal((await worker.fetch(request, environment)).status, 403);
  }
  assert.equal(worker.scheduled, undefined);
});
test('P9A preview는 실제 full router를 통과하고 SELECT 3회 meta를 보존', async () => {
  const token = 'b'.repeat(64), sql = [];
  const env = { P9A_PRIVATE_ONLY: 'YES', P9A_DB_ID: DISPOSABLE.id, P9A_EXPIRES_AT: String(Date.now() + 60000),
    P9A_AUTH_HASH: createHash('sha256').update(token).digest('hex'), DB: { prepare(statement) {
      sql.push(statement);
      return { bind: () => ({ all: async () => ({ results: statement.startsWith('SELECT c.ticker')
        ? [{ ticker: 'O', sector: 'Real Estate', industry: 'REIT - Retail', cik: null }] : [],
      meta: { duration: 1, rows_written: 0, rows_read: 1 } }) }) };
    } } };
  const response = await worker.fetch(new Request(`https://private.test/api/companies/O/specialized-metrics?${new URLSearchParams(seriesParameters(SERIES[0]))}`,
    { headers: { Authorization: `Bearer ${token}`, 'X-P9A-Probe': 'synthetic' } }), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).economicContinuityAssumed, false);
  assert.equal(sql.length, 3); assert.ok(sql.every(statement => /^SELECT\b/i.test(statement)));
  assert.deepEqual(JSON.parse(response.headers.get('X-P9A-D1')), { queries: 3, durationMs: 3, rowsRead: 3, rowsWritten: 0 });
});
test('P9A semantic gate는 provenance 원문/경계 삭제/숫자 변조를 거부', () => {
  const data = { ticker: 'O', analysisProfile: { type: 'REIT' }, data: [{ value: 1, definitionVersion: 'v1', validationStatus: 'parsed' }],
    economicContinuityAssumed: false, definitionBoundaries: [] };
  const expected = semanticHash(data), series = { expected: 1 };
  verifySeries(data, series, expected);
  for (const modified of [{ ...data, economicContinuityAssumed: true }, { ...data, definitionBoundaries: null },
    { ...data, data: [{ ...data.data[0], provenance: [] }] }, { ...data, data: [{ ...data.data[0], value: 2 }] }]) {
    assert.throws(() => verifySeries(modified, series, expected));
  }
});
test('P9A 토큰 인증 401이면 Observability 조회/재시도 없음', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url); return Response.json({ success: false }, { status: 401 });
  });
  const result = await collectCpu({}, 'SYNTHETIC_TEST_CREDENTIAL');
  assert.equal(result.verdict, 'NOT VERIFIED'); assert.equal(result.httpStatus, 401);
  assert.deepEqual(calls, ['https://api.cloudflare.com/client/v4/user/tokens/verify']);
});
test('P9A 인증 성공 후에만 CPU API 접근, CPU API 401도 재시도 없음', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return calls.length === 1 ? Response.json({ success: true, result: { status: 'active' } })
      : Response.json({ success: false }, { status: 401 });
  });
  const result = await collectCpu({ runId: 'test', startedAt: new Date().toISOString(), workerName: 'test' }, 'SYNTHETIC_TEST_CREDENTIAL');
  assert.equal(result.httpStatus, 401); assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith('/user/tokens/verify')); assert.ok(calls[1].endsWith('/workers/observability/telemetry/query'));
});
