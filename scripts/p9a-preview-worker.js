import worker from '../worker/src/index.js';

// 격리 preview에서 실제 앱 router를 실행한다. 쓰기 route와 scheduled handler는 노출하지 않는다.
export default { async fetch(request, environment, context) {
  const url = new URL(request.url);
  const expiry = Number(environment.P9A_EXPIRES_AT);
  if (environment.P9A_PRIVATE_ONLY !== 'YES' || !environment.DB
    || environment.P9A_DB_ID !== 'de3f265c-d6ec-4561-8a53-64effad66eb5'
    || !Number.isFinite(expiry) || Date.now() >= expiry || request.method !== 'GET'
    || !/^\/api\/companies\/[A-Za-z][A-Za-z0-9.\-]{0,9}\/specialized-metrics$/.test(url.pathname)) {
    return new Response(null, { status: 403 });
  }
  const supplied = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!supplied || !/^[a-f0-9]{64}$/.test(environment.P9A_AUTH_HASH || '')) return new Response(null, { status: 403 });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== environment.P9A_AUTH_HASH) return new Response(null, { status: 403 });
  const probeId = request.headers.get('X-P9A-Probe');
  if (!/^[a-z0-9-]{1,100}$/.test(probeId || '')) return new Response(null, { status: 400 });
  const metrics = { queries: 0, durationMs: 0, rowsRead: 0, rowsWritten: 0 };
  const DB = { prepare(sql) {
    if (!/^SELECT\b/i.test(sql.trim())) throw new Error('읽기 전용 preview입니다.');
    const make = parameters => ({ bind: (...values) => make(values),
      async all() {
        const result = await environment.DB.prepare(sql).bind(...parameters).all();
        metrics.queries++; metrics.durationMs += result.meta?.duration || 0;
        metrics.rowsRead += result.meta?.rows_read || 0; metrics.rowsWritten += result.meta?.rows_written || 0;
        if (metrics.rowsWritten) throw new Error('읽기 전용 preview에서 쓰기 감지');
        return result;
      }, async first(column) {
        const result = (await this.all()).results[0];
        return column ? result?.[column] ?? null : result ?? null;
      } });
    return make([]);
  } };
  const response = await worker.fetch(request, { ...environment, DB }, context);
  console.log({ p9aProbeId: probeId, p9aD1: metrics });
  const headers = new Headers(response.headers);
  headers.set('X-P9A-D1', JSON.stringify(metrics));
  return new Response(response.body, { status: response.status, headers });
} };
