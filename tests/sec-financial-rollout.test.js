import test from 'node:test';
import assert from 'node:assert/strict';
import rollout from '../scripts/sec-financial-rollout-worker.js';
import { runFundamentalBatch } from '../worker/src/fundamental-sync.js';

test('소규모 운영 검증 모드는 전역 재무 큐의 DB 접근과 외부 호출을 시작하지 않는다', async () => {
  const result = await runFundamentalBatch({ SEC_FINANCIAL_ROLLOUT_MODE: 'manual',
    DB: { prepare() { throw new Error('전체 큐 DB 접근 금지'); } } });
  assert.deepEqual(result.results, []);
  assert.equal(result.status, 'paused');
});

test('원격 검증 도구는 5종목 밖의 쓰기와 전체 실행을 거부한다', async () => {
  const environment = { SEC_USER_AGENT: '검증용 example@test.invalid', DB: { prepare() { throw new Error('DB 접근 금지'); } } };
  for (const path of ['/sec-reprocess/ABT', '/sec-reprocess/all', '/sec-reprocess', '/api/fundamentals/run']) {
    assert.equal((await rollout.fetch(new Request(`https://preview.test${path}`, { method: 'POST' }), environment)).status, 404);
  }
});

test('SEC 사전 확인은 한 번 호출하고 DB와 응답 본문을 출력하지 않는다', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ facts: { 'us-gaap': {} } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await rollout.fetch(new Request('https://preview.test/sec-preflight'), {
    SEC_USER_AGENT: '검증용 example@test.invalid', DB: { prepare() { throw new Error('DB 접근 금지'); } }
  });
  assert.deepEqual(await result.json(), { secStatus: 200, secContentType: 'application/json', configured: true, databaseWrite: false });
  assert.equal(calls, 1);
});

test('운영 연락처가 없으면 SEC 외부 호출 전 차단한다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('SEC 요청 금지'); });
  const result = await rollout.fetch(new Request('https://preview.test/sec-preflight'), { SEC_USER_AGENT: '앱 이름만' });
  assert.equal(result.status, 503);
});

// Node fetch의 옵션 허용 여부에 기대지 않고 Workers에 보내는 옵션·응답 분기를 명시적으로 검사한다.
const preflightEnvironment = { SEC_USER_AGENT: '검증용 example@test.invalid',
  DB: { prepare() { throw new Error('사전 확인 DB 접근 금지'); } } };

for (const status of [302, 403, 429, 500]) {
  test(`SEC 사전 확인은 ${status} HTML의 원래 상태를 보존하고 한 번만 요청한다`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response('<html>검증용 오류</html>', { status, headers: { 'Content-Type': 'text/html', Location: 'https://example.invalid/secret?token=hidden' } });
    });
    const result = await rollout.fetch(new Request('https://preview.test/sec-preflight'), preflightEnvironment);
    const body = await result.json();
    assert.equal(result.status, 502);
    assert.equal(body.secStatus, status);
    assert.equal(body.secContentType, 'text/html');
    assert.equal(body.error, status === 302 ? 'SEC_PREFLIGHT_REDIRECT_ERROR' : 'SEC_PREFLIGHT_HTTP_ERROR');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(body).includes('hidden'), false);
    assert.equal(JSON.stringify(body).includes('<html>'), false);
  });
}

test('200이라도 JSON이 아닌 응답은 파싱하지 않고 실패 처리한다', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('검증용 text', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  const body = await (await rollout.fetch(new Request('https://preview.test/sec-preflight'), preflightEnvironment)).json();
  assert.equal(body.secStatus, 200);
  assert.equal(body.error, 'SEC_PREFLIGHT_NON_JSON');
});

test('JSON 파싱 실패도 원래 HTTP 200과 content-type을 숨기지 않는다', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{손상 JSON', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const result = await rollout.fetch(new Request('https://preview.test/sec-preflight'), preflightEnvironment);
  const body = await result.json();
  assert.equal(result.status, 502);
  assert.equal(body.secStatus, 200);
  assert.equal(body.secContentType, 'application/json');
  assert.equal(body.error, 'SEC_PREFLIGHT_INVALID_JSON');
});

test('유효 JSON이어도 SEC 원본 구조가 아니면 정상으로 단정하지 않는다', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const body = await (await rollout.fetch(new Request('https://preview.test/sec-preflight'), preflightEnvironment)).json();
  assert.equal(body.error, 'SEC_PREFLIGHT_SCHEMA_ERROR');
});
