import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { adminToken, createAdminDatabase } from './specialized-d1-admin.mjs';
import { SERIES, statistics, semanticHash } from './p77-gate-core.mjs';
import { ACCOUNT, DISPOSABLE, baselineSeries, seriesUrl, verifySeries,
  previewConfig, observabilityToken, collectCpu } from './p9a-audit-core.mjs';

// 고정 disposable DB + 만료되는 비공개 preview만 사용한다. production 인자/쓰기 API는 없다.
if (process.argv.length !== 2) throw new Error('P9A preview 도구는 추가 인자를 받지 않습니다.');
const token = adminToken(), privateToken = randomBytes(32).toString('hex');
const runId = Date.now().toString(36), workerName = `us-stock-p9a-gate-${runId}`, previewName = 'route-cpu';
const previewPath = `/workers/workers/${workerName}/previews/${previewName}`;
const directory = resolve('backups/p9a'); mkdirSync(directory, { recursive: true });
const report = { phase: 'P9A', runId, workerName, previewName, startedAt: new Date().toISOString(),
  productionWrites: 0, samples: [], cleanup: 'NOT STARTED', cpu: { verdict: 'NOT VERIFIED' } };
const save = () => writeFileSync(resolve(directory, 'preview-results.json'), JSON.stringify(report, null, 2));
async function cf(path, method = 'GET') {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
  const json = await response.json(); return { status: response.status, success: json.success, result: json.result };
}
async function preview(configFile) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--use-system-ca', resolve('node_modules/wrangler/wrangler-dist/cli.js'),
      'preview', '--config', configFile, '--name', previewName, '--ignore-base-config', '--json'],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => fail(new Error('P9A Wrangler 실행 실패')));
    child.on('exit', code => {
      if (code) fail(new Error(`P9A preview 실패 exit=${code}, apiCode=${error.match(/\[code:\s*(\d+)\]/)?.[1] || 'unknown'}`));
      else { try { done(JSON.parse(output)); } catch { fail(new Error('P9A preview JSON 형식 오류')); } }
    });
  });
}
try {
  const DB = createAdminDatabase({ accountId: ACCOUNT, dbId: DISPOSABLE.id, token });
  if ((await DB.identity()).name !== DISPOSABLE.name) throw new Error('P9A disposable identity 불일치');
  report.baseline = await baselineSeries(DB);
  if (DB.metrics.rows_written) throw new Error('P9A baseline 쓰기 감지');
  const config = previewConfig({ workerName, authHash: createHash('sha256').update(privateToken).digest('hex'), expiresAt: Date.now() + 3600000 });
  const configFile = resolve(directory, 'preview.config.json'); writeFileSync(configFile, JSON.stringify(config, null, 2));
  const created = await preview(configFile), details = await cf(previewPath);
  if (!details.success) throw new Error('P9A preview identity 확인 실패');
  const urls = [...(created.preview?.urls || []), ...(created.deployment?.urls || []), ...(details.result?.urls || []),
    created.url, created.preview_url, created.preview?.url, details.result?.url, details.result?.preview_url, details.result?.subdomain?.url];
  const base = urls.find(value => typeof value === 'string' && /^https:\/\//.test(value));
  if (!base) throw new Error('P9A 공식 preview URL 미확보');
  report.previewId = details.result.id; report.previewUrl = base;
  console.log(JSON.stringify({ step: 'preview-created', workerName, previewId: report.previewId }));
  let ready = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    let response;
    try { response = await fetch(seriesUrl(base, SERIES[0]), { headers: { Authorization: `Bearer ${privateToken}`, 'X-P9A-Probe': `${runId}-ready-${attempt}` }, signal: AbortSignal.timeout(15000) }); }
    catch { if (attempt === 5) throw new Error('P9A readiness 네트워크 대기 한도'); await delay(3000); continue; }
    if (response.ok) { verifySeries(await response.json(), SERIES[0], report.baseline[SERIES[0].id]); ready = true; break; }
    if (response.status !== 404) throw new Error(`P9A readiness HTTP ${response.status}`);
    await delay(3000);
  }
  if (!ready) throw new Error('P9A preview 전파 대기 한도');
  for (const series of SERIES) {
    for (let sample = 0; sample <= 10; sample++) {
      const probeId = `${runId}-${series.id}-${sample}`;
      const response = await fetch(seriesUrl(base, series), { headers: { Authorization: `Bearer ${privateToken}`, 'X-P9A-Probe': probeId }, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`P9A ${series.id} HTTP ${response.status}`);
      const data = await response.json(); verifySeries(data, series, report.baseline[series.id]);
      const d1 = JSON.parse(response.headers.get('X-P9A-D1'));
      if (d1.rowsWritten !== 0 || d1.queries !== 3) throw new Error('P9A D1 통계 불일치');
      report.samples.push({ probeId, series: series.id, warmup: sample === 0, httpStatus: response.status,
        semanticHash: semanticHash(data), rowCount: data.data.length, d1 });
    }
    save(); console.log(JSON.stringify({ step: 'series-pass', series: series.id, rows: series.expected }));
  }
  report.querySemantics = 'PASS';
  report.d1Duration = statistics(report.samples.filter(row => !row.warmup).map(row => row.d1.durationMs));
  await delay(30000);
  report.cpu = await collectCpu(report, observabilityToken());
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  const found = await cf(previewPath).catch(() => ({ status: 0 }));
  if (found.success) {
    const removed = await cf(previewPath, 'DELETE');
    report.cleanup = removed.success && (await cf(previewPath)).status === 404 ? 'PASS' : 'NOT VERIFIED';
  } else report.cleanup = found.status === 404 ? 'NO PREVIEW CREATED' : 'NOT VERIFIED';
  save(); console.log(JSON.stringify({ step: 'final', requests: report.samples.length, semantics: report.querySemantics,
    cpu: report.cpu.verdict, d1: report.d1Duration, cleanup: report.cleanup, error: report.error }));
  if (report.cpu.verdict !== 'PASS' || report.cleanup !== 'PASS') process.exitCode = 1;
}
