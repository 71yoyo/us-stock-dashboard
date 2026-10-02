import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SERIES, semanticHash, correlateCpu } from './p77-gate-core.mjs';
import { readSpecializedHttpSeries } from '../worker/src/specialized-metric-http.js';

export const ACCOUNT = '3b11130d1e729d56312f9ae504becc60';
export const DISPOSABLE = { id: 'de3f265c-d6ec-4561-8a53-64effad66eb5', name: 'us-stock-dashboard-p75-rehearsal-20261001' };
export const productionWorker = 'us-stock-dashboard-api';
export const seriesParameters = series => ({ metric: series.query.metricCode, scope: series.query.periodScope,
  basis: series.query.valueBasis, shareBasis: series.query.shareBasis });
export const seriesUrl = (base, series) => {
  const url = new URL('/api/companies/O/specialized-metrics', base);
  url.search = new URLSearchParams(seriesParameters(series)).toString(); return url;
};

// P7.7과 동일한 query service의 DTO 결과를 baseline으로 삼는다. 기대값/정의를 다시 구현하지 않는다.
export async function baselineSeries(DB) {
  const expected = {};
  for (const series of SERIES) {
    const result = await readSpecializedHttpSeries({ DB }, series.query);
    verifySeries(result, series, semanticHash(result)); expected[series.id] = semanticHash(result);
  }
  return expected;
}
export function verifySeries(data, series, expectedHash) {
  if (data?.ticker !== 'O' || data.analysisProfile?.type !== 'REIT' || data.data?.length !== series.expected
    || data.economicContinuityAssumed !== false || !Array.isArray(data.definitionBoundaries)
    || data.data.some(row => !Number.isFinite(row.value) || !row.definitionVersion || !row.validationStatus
      || Object.hasOwn(row, 'provenance')) || semanticHash(data) !== expectedHash) {
    throw new Error('P9A HTTP response/query service 의미 불일치');
  }
}
export function previewConfig({ workerName, authHash, expiresAt }) {
  if (!/^us-stock-p9a-gate-[a-z0-9-]+$/.test(workerName) || !/^[a-f0-9]{64}$/.test(authHash)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3600000) {
    throw new Error('P9A preview identity/만료 guard 실패');
  }
  return { name: workerName, main: '../../scripts/p9a-preview-worker.js', account_id: ACCOUNT,
    compatibility_date: '2026-09-21', workers_dev: false, preview_urls: true,
    previews: { d1_databases: [{ binding: 'DB', database_id: DISPOSABLE.id, database_name: DISPOSABLE.name }],
      vars: { P9A_PRIVATE_ONLY: 'YES', P9A_DB_ID: DISPOSABLE.id, P9A_AUTH_HASH: authHash, P9A_EXPIRES_AT: String(expiresAt) },
      observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true } } } };
}
export function observabilityToken() {
  if (process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN) return process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN;
  const path = resolve('worker/.dev.vars.p9a');
  // 값보다 먼저 Git 제외/미추적을 검사하며 값·길이·hash는 어떤 로그에도 출력하지 않는다.
  execFileSync('git', ['check-ignore', '--', path], { stdio: 'pipe' });
  if (execFileSync('git', ['ls-files', '--', path], { encoding: 'utf8' }).trim()) throw new Error('CPU 환경 파일 Git 추적 감지');
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return null; }
  return content.match(/^\s*CLOUDFLARE_OBSERVABILITY_API_TOKEN\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
}
export async function collectCpu(report, bearer) {
  if (!bearer) return { verdict: 'NOT VERIFIED', reason: 'observability credential 미확보' };
  // 사용자 요청대로 같은 메모리 토큰의 인증부터 확인한다. 401/비활성 토큰이면 CPU API를 호출하지 않는다.
  const authentication = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20000) });
  const verified = await authentication.json();
  if (authentication.status !== 200 || !verified.success || verified.result?.status !== 'active') {
    return { verdict: 'NOT VERIFIED', httpStatus: authentication.status, reason: '토큰 인증 실패: CPU 조회 중단' };
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queryId: `p9a-${report.runId}-${Date.now().toString(36)}`, timeframe: { from: Date.parse(report.startedAt) - 1000, to: Date.now() },
      view: 'events', limit: 1000, dry: true,
      parameters: { filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: report.workerName }] } }),
    signal: AbortSignal.timeout(45000) });
  const json = await response.json();
  if (!response.ok || !json.success) return { verdict: 'NOT VERIFIED', httpStatus: response.status };
  const events = json.result?.events?.events;
  if (!Array.isArray(events) || events.length >= 1000) return { verdict: 'NOT VERIFIED', reason: '로그 누락/페이지 제한' };
  const probes = new Set(report.samples.map(sample => sample.probeId));
  const rows = [];
  for (const event of events) {
    const invocation = event.$workers;
    const probeId = invocation?.event?.request?.headers?.['x-p9a-probe'];
    if (!probes.has(probeId)) continue;
    if (invocation.scriptName !== report.workerName
      || report.previewId && invocation.preview?.id !== report.previewId
      || report.versionId && invocation.scriptVersion?.id !== report.versionId) {
      throw new Error('P9A CPU invocation identity 불일치');
    }
    rows.push({ probeId, cpuTimeMs: invocation.cpuTimeMs, wallTimeMs: invocation.wallTimeMs, outcome: invocation.outcome });
  }
  // 인증 header/원시 invocation은 버리고 요청 ID와 실제 CPU 통계만 보존한다.
  return { source: 'Cloudflare Workers Observability actual invocation', httpStatus: response.status,
    ...correlateCpu([report], rows), samples: rows };
}
