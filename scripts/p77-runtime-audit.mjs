import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { adminToken, createAdminDatabase } from './specialized-d1-admin.mjs';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';
import { SERIES, semanticHash, previewConfig, verifyResponse, statistics } from './p77-gate-core.mjs';

// P7.7 고정 rehearsal 대상이다. 생산 DB/Worker를 CLI 인자로 받지 않으며 앱 config도 읽지 않는다.
const accountId = '3b11130d1e729d56312f9ae504becc60';
const dbId = 'de3f265c-d6ec-4561-8a53-64effad66eb5';
const dbName = 'us-stock-dashboard-p75-rehearsal-20261001';
const runId = Date.now().toString(36);
const workerName = `us-stock-p77-gate-${runId}`;
const previewName = 'cpu-gate';
const directory = resolve('backups/p77');
const token = adminToken();
const privateToken = randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const previewPath = `/workers/workers/${workerName}/previews/${previewName}`;
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const report = { phase: 'P7.7', workerName, previewName, runId, startedAt: new Date().toISOString(),
  productionTraffic: 0, productionWrites: 0, dbWrites: 0, samples: [], cleanup: 'NOT STARTED', cpuGate: 'NOT VERIFIED' };
const selected = process.argv.slice(2);
if (selected.length && (selected.length !== 2 || selected[0] !== '--series' || !SERIES.some(row => row.id === selected[1]))) {
  throw new Error('허용된 P7.7 series 한 개만 선택할 수 있습니다.');
}
const measuredSeries = selected.length ? SERIES.filter(row => row.id === selected[1]) : SERIES;
mkdirSync(directory, { recursive: true });
const save = () => {
  const json = JSON.stringify(report, null, 2);
  writeFileSync(resolve(directory, `runtime-results-${runId}.json`), json);
  writeFileSync(resolve(directory, 'runtime-results.json'), json);
};
async function cf(path, method = 'GET', body, bearer = token) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...headers, Authorization: `Bearer ${bearer}` },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
  const json = await response.json();
  return { status: response.status, success: json.success, result: json.result,
    errorCodes: (json.errors || []).map(row => row.code) };
}
async function wrangler(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--use-system-ca', resolve('node_modules/wrangler/bin/wrangler.js'), ...args],
      { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => fail(new Error('Wrangler 실행 실패')));
    child.on('exit', code => {
      if (code !== 0) {
        // 임시 auth 원문/실제 credential을 출력하지 않는다. CLI 오류 코드만 보고한다.
        const apiCode = error.match(/\[code:\s*(\d+)\]/)?.[1];
        fail(new Error(`P7.7 preview 준비 실패: exit=${code}, apiCode=${apiCode || 'unknown'}`));
      } else {
        try { done(JSON.parse(output)); } catch { fail(new Error('P7.7 preview JSON 형식 오류')); }
      }
    });
  });
}
let previewCreated = false;
try {
  const DB = createAdminDatabase({ accountId, dbId, token });
  const identity = await DB.identity();
  if (identity.name !== dbName) throw new Error('P7.7 disposable D1 identity 불일치');
  const expected = new Map();
  for (const series of SERIES) {
    const data = await querySpecializedMetrics(DB, series.query);
    verifyResponse(data, series, semanticHash(data));
    expected.set(series.id, semanticHash(data));
  }
  report.baseline = Object.fromEntries(expected);
  if (DB.metrics.rows_written !== 0) throw new Error('read-only baseline 쓰기 감지');
  const config = previewConfig({ accountId, dbId, dbName, workerName, authHash: hash(privateToken),
    expiresAt: Date.now() + 3600000, main: '../../scripts/p77-query-worker.js' });
  const configFile = resolve(directory, 'preview.config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ step: 'baseline', series: expected.size, rowsWritten: 0, workerName }));
  const preview = await wrangler(['preview', '--config', configFile, '--name', previewName, '--ignore-base-config', '--json']);
  const details = await cf(previewPath);
  if (!details.success) throw new Error('preview 배포 후 identity 확인 실패');
  previewCreated = true;
  // URL은 공식 CLI/API에서 받은 값만 사용한다. auth 값은 URL에 넣지 않는다.
  const candidates = [...(preview.preview?.urls || []), ...(preview.deployment?.urls || []), ...(details.result?.urls || []),
    preview.url, preview.preview_url, preview.preview?.url, details.result?.url,
    details.result?.preview_url, details.result?.subdomain?.url];
  const url = candidates.find(value => typeof value === 'string' && /^https:\/\//.test(value));
  if (!url) {
    report.previewResponseKeys = { cli: Object.keys(preview), api: Object.keys(details.result || {}) };
    save(); throw new Error('공식 preview 응답에서 URL 미확보');
  }
  report.previewId = details.result?.id;
  report.observability = details.result?.observability;
  report.previewUrl = url;
  console.log(JSON.stringify({ step: 'preview-created', workerName, previewId: report.previewId }));
  // 새 preview URL의 전파 지연만 제한적으로 기다린다. 측정 표본에는 readiness 요청을 섞지 않는다.
  report.readiness = [];
  let ready = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const requestUrl = new URL('/__p77_specialized_get', url);
    requestUrl.search = new URLSearchParams(measuredSeries[0].query).toString();
    let response;
    try {
      response = await fetch(requestUrl, { headers: { Authorization: `Bearer ${privateToken}`,
        'X-P77-Probe': `${runId}-readiness-${attempt}` }, signal: AbortSignal.timeout(15000) });
    } catch {
      report.readiness.push({ attempt, networkError: true });
      if (attempt < 5) { await delay(3000); continue; }
      throw new Error('preview readiness 네트워크 대기 한도 초과');
    }
    report.readiness.push({ attempt, httpStatus: response.status });
    if (response.ok) { verifyResponse((await response.json()).data, measuredSeries[0], expected.get(measuredSeries[0].id)); ready = true; break; }
    if (response.status !== 404) throw new Error(`preview readiness 거부: HTTP ${response.status}`);
    if (attempt < 5) await delay(3000);
  }
  if (!ready) throw new Error('preview URL 전파 대기 한도 초과');
  for (const series of measuredSeries) {
    for (let sample = 0; sample <= 10; sample++) {
      const probeId = `${runId}-${series.id}-${sample}`;
      const requestUrl = new URL('/__p77_specialized_get', url);
      requestUrl.search = new URLSearchParams(series.query).toString();
      const started = performance.now();
      const response = await fetch(requestUrl, { headers: { Authorization: `Bearer ${privateToken}`, 'X-P77-Probe': probeId },
        signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`P7.7 GET 실패: ${series.id}, HTTP ${response.status}`);
      const result = await response.json();
      verifyResponse(result.data, series, expected.get(series.id));
      if (result.probeId !== probeId || result.d1.rowsWritten !== 0 || result.d1.queries !== 2) throw new Error('D1 통계 불일치');
      report.samples.push({ probeId, series: series.id, warmup: sample === 0, httpStatus: response.status,
        semanticHash: semanticHash(result.data), rowCount: result.data.data.length,
        clientWallMs: performance.now() - started, d1: result.d1 });
    }
    console.log(JSON.stringify({ step: 'series-complete', series: series.id, rowCount: series.expected, samples: 10 }));
    save();
  }
  report.querySemantics = 'PASS';
  // 로그 수집의 비동기 전파 시간을 확보한 뒤 임시 preview를 닫는다. CPU로 간주하지 않는다.
  console.log(JSON.stringify({ step: 'awaiting-telemetry', samples: report.samples.length, workerName,
    observability: report.observability }));
  save();
  await delay(30000);
  // 실제 CPU 수집 권한이 없으면 client wall/D1 시간을 CPU로 바꾸지 않고 미검증으로 남긴다.
  const observabilityToken = process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN || token;
  const telemetry = await cf('/workers/observability/telemetry/query', 'POST', {
    queryId: `p77-${runId}`, timeframe: { from: Date.parse(report.startedAt) - 1000, to: Date.now() },
    view: 'events', limit: 1000, dry: true,
    parameters: { filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: workerName }] }
  }, observabilityToken);
  report.telemetry = { httpStatus: telemetry.status, success: telemetry.success, errorCodes: telemetry.errorCodes };
  const events = telemetry.result?.events?.events || [];
  // 관련 invocation 통계만 추출한다. 인증 header가 포함될 수 있는 원시 로그는 저장하지 않는다.
  const invocations = events.filter(row => Number.isFinite(row.$workers?.cpuTimeMs));
  report.actualInvocations = invocations.map(row => ({ cpuTimeMs: row.$workers.cpuTimeMs,
    wallTimeMs: row.$workers.wallTimeMs, outcome: row.$workers.outcome,
    requestId: row.$workers.requestId, timestamp: row.timestamp }));
  // 요청과 로그의 일대일 대응 없이 총수만 같다고 PASS로 판정하지 않는다. 로그 상관은 별도 검증한다.
  report.cpuGate = 'NOT VERIFIED';
  const measured = report.samples.filter(row => !row.warmup);
  report.clientWall = statistics(measured.map(row => row.clientWallMs));
  report.d1Duration = statistics(measured.map(row => row.d1.durationMs));
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  // 이 run에서 만든 preview만 삭제한다. disposable D1/production Worker는 삭제하지 않는다.
  const found = await cf(previewPath).catch(() => ({ status: 0 }));
  if (previewCreated || found.success) {
    const removed = await cf(previewPath, 'DELETE');
    const verify = await cf(previewPath);
    report.cleanup = removed.success && verify.status === 404 ? 'PASS' : 'NOT VERIFIED';
  } else report.cleanup = found.status === 404 ? 'NO PREVIEW CREATED' : 'NOT VERIFIED';
  save();
  console.log(JSON.stringify({ step: 'final', requests: report.samples.length, querySemantics: report.querySemantics,
    cpuGate: report.cpuGate, telemetry: report.telemetry, cleanup: report.cleanup, error: report.error }));
}
