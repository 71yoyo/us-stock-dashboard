import test from 'node:test';
import assert from 'node:assert/strict';
import rollout from '../scripts/sec-financial-phase1-6b-worker.js';

// 설정 오류 시 운영 DB와 SEC에 접근하기 전에 중단한다.
test('Phase 1.6B는 실제 manual 설정이 없으면 외부 호출과 DB 쓰기를 차단한다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('외부 호출 금지'); });
  const result = await rollout.fetch(new Request('https://preview.test/sec-reprocess/ABBV', { method: 'POST' }), {
    DB: { prepare() { throw new Error('DB 접근 금지'); } }, SEC_FINANCIAL_ROLLOUT_MODE: 'normal'
  });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).databaseWrite, false);
});

test('Phase 1.6B는 이전 5종목·전역 요청·사전 확인을 거부하고 manual 읽기만 허용한다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('외부 호출 금지'); });
  const environment = { SEC_FINANCIAL_ROLLOUT_MODE: 'manual', SEC_USER_AGENT: '검증용 example@test.invalid',
    DB: { prepare() { throw new Error('DB 접근 금지'); } } };
  for (const ticker of ['NVDA', 'AAPL', 'MSFT', 'JPM', 'O', 'all', 'PG']) {
    const result = await rollout.fetch(new Request(`https://preview.test/sec-reprocess/${ticker}`, { method: 'POST' }), environment);
    assert.equal(result.status, 404);
  }
  assert.equal((await rollout.fetch(new Request('https://preview.test/sec-preflight'), environment)).status, 404);
  const state = await rollout.fetch(new Request('https://preview.test/sec-rollout-mode'), environment);
  assert.deepEqual(await state.json(), { rolloutMode: 'manual', databaseWrite: false });
});

test('Phase 1.6B는 승인된 5종목도 이미 처리된 버전이면 재수집하지 않는다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('SEC 재호출 금지'); });
  const environment = { SEC_FINANCIAL_ROLLOUT_MODE: 'manual', SEC_USER_AGENT: '검증용 example@test.invalid',
    DB: { prepare(sql) {
      assert.match(sql, /SELECT details FROM fundamental_jobs/);
      return { bind() { return this; }, async first() { return { details: '{"metadataVersion":1}' }; } };
    } } };
  for (const ticker of ['ABBV', 'ABT', 'AMZN', 'GOOGL', 'TSLA']) {
    const result = await rollout.fetch(new Request(`https://preview.test/sec-reprocess/${ticker}`, { method: 'POST' }), environment);
    assert.equal(result.status, 409);
  }
});
