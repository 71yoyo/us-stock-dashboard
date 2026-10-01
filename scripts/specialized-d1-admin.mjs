import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 토큰은 환경변수(로컬/CI) 또는 기존 Wrangler 로그인에서 메모리로만 읽는다. 로그/SQL 파일에 쓰지 않는다.
export function adminToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (!process.env.APPDATA) throw new Error('CLOUDFLARE_API_TOKEN 또는 Wrangler 로그인이 필요합니다.');
  const auth = readFileSync(join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
  const token = auth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error('Cloudflare 관리자 인증이 필요합니다.');
  return token;
}
export function createAdminDatabase({ accountId, dbId, token, fetcher = fetch, allowWrite = false, intervalMs = 275 }) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9-]{36}$/.test(dbId) || !token) throw new Error('D1 관리자 설정 오류');
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}`;
  const metrics = { requests: 0, statements: 0, rows_read: 0, rows_written: 0, d1_duration_ms: 0, retries: 0 };
  let previous = 0;
  async function request(path, body) {
    // 계정 전체 1200/5분보다 낮은 단일 controller 속도다. 다른 도구의 사용량은 별도로 합산해야 한다.
    await delay(Math.max(0, previous + intervalMs - Date.now())); previous = Date.now();
    metrics.requests++;
    let response;
    try { response = await fetcher(`${base}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) }); }
    catch { throw new Error('network: D1 관리자 요청 실패'); }
    const json = await response.json();
    if (!response.ok || !json.success || json.result?.some?.(row => row.success === false)) {
      // 서버 SQL 오류에 artifact 값/토큰이 섞일 가능성이 있어 raw body를 로그에 내보내지 않는다.
      const messages = (json.errors || []).map(row => row.message).join(' ');
      if (/CHECK constraint failed/i.test(messages)) throw new Error('CHECK constraint failed: coordination 거부');
      if (/UNIQUE constraint failed/i.test(messages)) throw new Error('UNIQUE constraint failed: 의미 충돌');
      if (/no such table/i.test(messages)) throw new Error('D1 schema 미확보');
      if (response.status === 429) throw new Error('D1 API rate limit: 운영자가 사용량/대기 시간을 확인해 주세요.');
      if ([502,503,504].includes(response.status) || /overloaded|temporarily unavailable/i.test(messages)) throw new Error('temporarily unavailable: D1 관리자 API');
      throw new Error(`D1 관리자 API 거부: HTTP ${response.status}`);
    }
    return json.result;
  }
  async function execute(statements) {
    if (!allowWrite && statements.some(row => !/^\s*(SELECT|PRAGMA table_info)\b/i.test(row.sql))) throw new Error('verify-only: write 금지');
    for (const row of statements) {
      if (row.params.length > 100 || Buffer.byteLength(row.sql) > 100000) throw new Error('D1 SQL/bind 제한 초과');
    }
    metrics.statements += statements.length;
    const result = await request('/query', { batch: statements });
    if (!Array.isArray(result) || result.length !== statements.length) throw new Error('D1 batch 응답 건수 불일치');
    for (const row of result) {
      for (const key of ['rows_read','rows_written']) metrics[key] += row.meta?.[key] || 0;
      metrics.d1_duration_ms += row.meta?.duration || 0;
    }
    return result;
  }
  const DB = { metrics, identity: () => request(''), prepare(sql) {
    const make = params => ({ sql, params, bind: (...values) => make(values),
      all: async () => (await execute([{ sql, params }]))[0],
      first: async () => (await execute([{ sql, params }]))[0].results[0] || null,
      run: async () => (await execute([{ sql, params }]))[0] });
    return make([]);
  }, batch: statements => execute(statements.map(({ sql, params }) => ({ sql, params }))) };
  return DB;
}
