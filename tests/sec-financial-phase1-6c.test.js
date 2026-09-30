import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { fundamentalQueueRuntimeStatus, runFundamentalBatch } from '../worker/src/fundamental-sync.js';

test('큐 운영 상태 진단은 기존 manual 조건을 유지하고 normal 및 미설정을 활성으로 판별한다', () => {
  assert.deepEqual(fundamentalQueueRuntimeStatus({ SEC_FINANCIAL_ROLLOUT_MODE: 'manual' }),
    { rolloutMode: 'manual', status: 'PAUSED' });
  assert.deepEqual(fundamentalQueueRuntimeStatus({ SEC_FINANCIAL_ROLLOUT_MODE: 'normal' }),
    { rolloutMode: 'normal', status: 'ACTIVE' });
  assert.deepEqual(fundamentalQueueRuntimeStatus({}), { rolloutMode: 'normal', status: 'ACTIVE' });
});

test('normal 큐는 manual early return을 통과하며 쓰기 차단 진단 DB에서 외부 호출 전에 멈춘다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('외부 API 호출 금지'); });
  let reachedStore = 0;
  // 실제 DB 대신 첫 접근부터 중단하는 진단용 객체로 제어 경로만 검증한다.
  const DB = { prepare() { reachedStore += 1; throw new Error('READ_ONLY_PROBE'); } };
  await assert.rejects(runFundamentalBatch({ SEC_FINANCIAL_ROLLOUT_MODE: 'normal', DB }), /READ_ONLY_PROBE/);
  assert.equal(reachedStore, 1);
});

test('운영 health는 runtime 큐 상태를 반환하지만 DB와 외부 API를 호출하지 않는다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('외부 API 호출 금지'); });
  for (const mode of ['manual', 'normal']) {
    const response = await worker.fetch(new Request('https://worker.test/api/health'), {
      SEC_FINANCIAL_ROLLOUT_MODE: mode, DB: { prepare() { throw new Error('DB 접근 금지'); } }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.fundamentalQueue, { rolloutMode: mode, status: mode === 'manual' ? 'PAUSED' : 'ACTIVE' });
    assert.equal(typeof payload.massiveConfigured, 'boolean');
    assert.equal(typeof payload.dividendPipelineEnabled, 'boolean');
  }
});
