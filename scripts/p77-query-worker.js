import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';

// 실제 D1 binding으로 기존 query service만 실행한다. 앱 Worker·Cron·쓰기 경로는 포함하지 않는다.
export default { async fetch(request, environment) {
  const url = new URL(request.url);
  if (environment.DB || environment.P77_PRIVATE_ONLY !== 'YES'
    || request.method !== 'GET' || url.pathname !== '/__p77_specialized_get'
    || !environment.P77_READ_ONLY || Date.now() >= Number(environment.P77_EXPIRES_AT)) {
    return new Response('임시 비공개 검증만 허용합니다.', { status: 403 });
  }
  // 임시 토큰 원문은 설정/로그에 저장하지 않는다. 인증도 실제 invocation CPU에 포함한다.
  const supplied = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!supplied || !/^[a-f0-9]{64}$/.test(environment.P77_AUTH_HASH || '')) return new Response(null, { status: 403 });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== environment.P77_AUTH_HASH) return new Response(null, { status: 403 });
  const probeId = request.headers.get('X-P77-Probe');
  if (!/^[a-z0-9-]{1,100}$/.test(probeId || '')) return new Response(null, { status: 400 });
  const metrics = { queries: 0, durationMs: 0, rowsRead: 0, rowsWritten: 0 };
  try {
    const DB = { prepare(sql) {
      if (!/^SELECT\b/i.test(sql.trim())) throw new Error('읽기 전용 검증입니다.');
      const make = params => ({ bind: (...values) => make(values), all: async () => {
        const result = await environment.P77_READ_ONLY.prepare(sql).bind(...params).all();
        metrics.queries++;
        metrics.durationMs += result.meta?.duration || 0;
        metrics.rowsRead += result.meta?.rows_read || 0;
        metrics.rowsWritten += result.meta?.rows_written || 0;
        if (metrics.rowsWritten) throw new Error('읽기 전용 경로에서 쓰기가 감지되었습니다.');
        return result;
      } });
      return make([]);
    } };
    const input = Object.fromEntries(url.searchParams);
    if (input.includeComparisons !== undefined) {
      if (!['true', 'false'].includes(input.includeComparisons)) throw new Error('boolean 형식 오류');
      input.includeComparisons = input.includeComparisons === 'true';
    }
    const data = await querySpecializedMetrics(DB, input);
    // 조회 식별자와 통계만 기록하며 URL/header/token/DB 값은 로그로 출력하지 않는다.
    console.log({ p77ProbeId: probeId, p77D1: metrics });
    return Response.json({ data, probeId, d1: metrics }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error({ p77ProbeId: probeId, p77Error: 'read-only-query-failed' });
    return new Response('조회 조건과 저장 무결성을 확인해 주세요.', { status: 400 });
  }
} };
