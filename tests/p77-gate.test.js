import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../scripts/p77-query-worker.js';
import { SERIES, previewConfig, semanticHash, verifyResponse, statistics, cpuVerdict, correlateCpu } from '../scripts/p77-gate-core.mjs';

test('P7.7 9 series와 기존 coverage 계약 유지', () => {
  assert.equal(SERIES.length, 9);
  assert.deepEqual(SERIES.map(row => row.expected), [40, 40, 19, 10, 10, 5, 20, 20, 10]);
});
const configInput = () => ({ accountId: 'a'.repeat(32), dbId: 'de3f265c-d6ec-4561-8a53-64effad66eb5',
  dbName: 'us-stock-dashboard-p75-rehearsal-20261001', workerName: 'us-stock-p77-gate-test',
  authHash: 'b'.repeat(64), expiresAt: Date.now() + 60000, main: '../../scripts/p77-query-worker.js' });
test('P7.7 preview에 production route/Cron/DB/원문 Secret 없음', () => {
  const config = previewConfig(configInput());
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, true);
  assert.equal(config.d1_databases, undefined); assert.equal(config.routes, undefined); assert.equal(config.triggers, undefined);
  assert.equal(config.previews.d1_databases[0].binding, 'P77_READ_ONLY');
  assert.equal(config.previews.observability.head_sampling_rate, 1);
});
test('P7.7 production DB/Worker/잘못된 격리 DB/만료 설정 거부', () => {
  for (const change of [{ dbId: '698ab9b8-4573-40c7-b119-d7b1d681abc8' },
    { workerName: 'us-stock-dashboard-api' }, { dbName: 'us-stock-pro' },
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 7200000 }]) {
    assert.throws(() => previewConfig({ ...configInput(), ...change }));
  }
});
test('P7.7 의미 hash는 키 순서만 무시하고 숫자/출처/상태를 보존', () => {
  assert.equal(semanticHash({ b: 2, a: 1 }), semanticHash({ a: 1, b: 2 }));
  assert.notEqual(semanticHash({ value: 1, validationStatus: 'parsed' }), semanticHash({ value: 1, validationStatus: 'validated' }));
});
test('P7.7 response 검증은 정의 경계/검증 상태 삭제를 거부', () => {
  const data = { data: [{ value: 1, unit: 'USD/share', definitionVersion: 'v1', validationStatus: 'parsed' }],
    definitionBoundaries: [], economicContinuityAssumed: false };
  verifyResponse(data, { expected: 1 }, semanticHash(data));
  assert.throws(() => verifyResponse({ ...data, economicContinuityAssumed: true }, { expected: 1 }, semanticHash(data)));
});
test('P7.7 CPU는 actual sample 전량과 high percentile 기준', () => {
  assert.equal(cpuVerdict([], 10), 'NOT VERIFIED');
  const samples = Array.from({ length: 10 }, () => ({ cpuTimeMs: 2, wallTimeMs: 100, outcome: 'ok' }));
  assert.equal(cpuVerdict(samples, 10), 'PASS');
  assert.equal(cpuVerdict([...samples.slice(0, 9), { cpuTimeMs: 11, wallTimeMs: 100, outcome: 'ok' }], 10), 'FAIL');
  assert.equal(cpuVerdict([...samples.slice(0, 9), { cpuTimeMs: 9, wallTimeMs: 100, outcome: 'ok' }], 10), 'FAIL');
  assert.equal(cpuVerdict([{ wallTimeMs: 100, outcome: 'ok' }], 1), 'NOT VERIFIED');
  assert.deepEqual(statistics([3, 1, 2]), { count: 3, p50: 2, p95: 3, max: 3 });
});
test('P7.7 인증 이전/만료/POST/production binding은 D1 접근 없이 거부', async () => {
  const environment = { P77_PRIVATE_ONLY: 'YES', P77_READ_ONLY: { prepare() { throw new Error('접근 금지'); } },
    P77_EXPIRES_AT: String(Date.now() + 60000), P77_AUTH_HASH: 'b'.repeat(64) };
  for (const [request, env] of [[new Request('https://private.invalid/__p77_specialized_get'), environment],
    [new Request('https://private.invalid/__p77_specialized_get', { method: 'POST' }), environment],
    [new Request('https://private.invalid/__p77_specialized_get'), { ...environment, DB: {} }],
    [new Request('https://private.invalid/__p77_specialized_get'), { ...environment, P77_EXPIRES_AT: '1' }]]) {
    assert.equal((await worker.fetch(request, env)).status, 403);
  }
});
test('P7.7 CPU는 request ID 대응 및 9 series 각각 10개 이상 필요', () => {
  const samples = SERIES.flatMap(series => Array.from({ length: 11 }, (_,index) => ({ probeId: `${series.id}-${index}`,
    series: series.id, warmup: index === 0 })));
  const rows = samples.map(sample => ({ probeId: sample.probeId, cpuTimeMs: 2, wallTimeMs: 300, outcome: 'ok' }));
  assert.equal(correlateCpu([{ samples }], rows).verdict, 'PASS');
  assert.equal(correlateCpu([{ samples }], rows.slice(1)).verdict, 'PASS');
  assert.equal(correlateCpu([{ samples }], rows.slice(2)).verdict, 'NOT VERIFIED');
  assert.equal(correlateCpu([{ samples }], [...rows, rows[0]]).verdict, 'NOT VERIFIED');
  assert.equal(correlateCpu([{ samples }], [...rows, { probeId: 'unknown', cpuTimeMs: 1, wallTimeMs: 1 }]).verdict, 'NOT VERIFIED');
});

// 합성 DB는 HTTP 안전 경로만 시험한다. 실제 CPU/값 검증 근거로 사용하지 않는다.
test('P7.7 인증된 GET만 SELECT 2회 실행하고 D1 통계를 보존', async () => {
  const supplied = 'a'.repeat(64);
  const statements = [];
  const environment = { P77_PRIVATE_ONLY: 'YES', P77_EXPIRES_AT: String(Date.now() + 60000),
    P77_AUTH_HASH: (await import('node:crypto')).createHash('sha256').update(supplied).digest('hex'),
    P77_READ_ONLY: { prepare(sql) {
      statements.push(sql);
      return { bind: () => ({ all: async () => ({ results: [],
        meta: { duration: 1, rows_read: 2, rows_written: 0 } }) }) };
    } } };
  const request = new Request(`https://private.invalid/__p77_specialized_get?${new URLSearchParams(SERIES[0].query)}`,
    { headers: { Authorization: `Bearer ${supplied}`, 'X-P77-Probe': 'test-get' } });
  const response = await worker.fetch(request, environment);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(statements.length, 2);
  assert.ok(statements.every(sql => /^SELECT\b/i.test(sql.trim())));
  assert.deepEqual(body.d1, { queries: 2, durationMs: 2, rowsRead: 4, rowsWritten: 0 });
  assert.equal(body.data.economicContinuityAssumed, false);
  const rejected = await worker.fetch(new Request(request.url, { headers: {
    Authorization: `Bearer ${supplied}`, 'X-P77-Probe': 'invalid probe' } }), environment);
  assert.equal(rejected.status, 400);
  assert.equal(statements.length, 2);
});

test('P7.7 SELECT 결과의 쓰기 통계 이상을 감지하면 응답을 차단', async () => {
  const supplied = 'a'.repeat(64);
  const environment = { P77_PRIVATE_ONLY: 'YES', P77_EXPIRES_AT: String(Date.now() + 60000),
    P77_AUTH_HASH: (await import('node:crypto')).createHash('sha256').update(supplied).digest('hex'),
    P77_READ_ONLY: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [],
      meta: { rows_written: 1 } }) }) }) } };
  const response = await worker.fetch(new Request(`https://private.invalid/__p77_specialized_get?${new URLSearchParams(SERIES[0].query)}`,
    { headers: { Authorization: `Bearer ${supplied}`, 'X-P77-Probe': 'test-write-guard' } }), environment);
  assert.equal(response.status, 400);
});
