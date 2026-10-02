import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { adminToken, createAdminDatabase } from './specialized-d1-admin.mjs';
import { SERIES, semanticHash } from './p77-gate-core.mjs';
import { ACCOUNT, productionWorker, baselineSeries, seriesUrl, verifySeries,
  collectCpu, observabilityToken } from './p9a-audit-core.mjs';

// 명시 승인된 P9A 배포 이후 GET/SELECT만 실행한다. 배포·Cron 호출·복구·설정 write는 없다.
if (process.argv.length !== 2) throw new Error('고정 P9A 운영 read-only smoke만 지원합니다.');
const evidence = JSON.parse(readFileSync('backups/p9a/cpu-evidence.json', 'utf8'));
assert.equal(evidence.verdict, 'PASS');
const deployment = JSON.parse(readFileSync('backups/p9a/deploy.json', 'utf8'));
assert.match(deployment.versionId || '', /^[a-f0-9-]{36}$/);
const report = { phase: 'P9A', runId: Date.now().toString(36), workerName: productionWorker,
  versionId: deployment.versionId, startedAt: new Date().toISOString(), samples: [], existingApi: {} };
const save = () => writeFileSync('backups/p9a/production-smoke.json', JSON.stringify(report, null, 2));
try {
  const DB = createAdminDatabase({ accountId: ACCOUNT, dbId: '698ab9b8-4573-40c7-b119-d7b1d681abc8', token: adminToken() });
  assert.equal((await DB.identity()).name, 'us-stock-pro');
  report.baseline = await baselineSeries(DB);
  const before = JSON.parse(readFileSync('backups/p9a/preflight.json', 'utf8')).api;
  const base = `https://${productionWorker}.771yoyo.workers.dev`;
  for (const path of ['/api/health', '/api/companies', '/api/companies/O', '/api/companies/JPM']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200); const data = await response.json();
    if (before[path]) assert.deepEqual(Object.keys(data), before[path].fields);
    if (path === '/api/health') assert.equal(data.fundamentalQueue.status, 'ACTIVE');
    if (path === '/api/companies') assert.equal(data.companies.length, 10);
    if (path.endsWith('/O')) assert.equal(data.company.analysisProfile.type, 'REIT');
    if (path.endsWith('/JPM')) assert.equal(data.company.analysisProfile.type, 'BANK');
    report.existingApi[path] = { httpStatus: response.status, fields: Object.keys(data) };
  }
  for (const series of SERIES) {
    for (let sample = 0; sample <= 10; sample++) {
      const probeId = `${report.runId}-${series.id}-${sample}`;
      const response = await fetch(seriesUrl(base, series), { headers: { 'X-P9A-Probe': probeId }, signal: AbortSignal.timeout(45000) });
      assert.equal(response.status, 200); const data = await response.json();
      verifySeries(data, series, report.baseline[series.id]);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      report.samples.push({ probeId, series: series.id, warmup: sample === 0,
        httpStatus: response.status, rowCount: data.data.length, semanticHash: semanticHash(data) });
    }
    save(); console.log(JSON.stringify({ step: 'production-series-pass', series: series.id, count: series.expected }));
  }
  // 빈/오류 요청도 공시 재수집이나 쓰기를 유발하지 않는다.
  const empty = await fetch(seriesUrl(base, SERIES[0]).toString().replace('/O/', '/JPM/'));
  assert.equal(empty.status, 200); const emptyData = await empty.json(); assert.equal(emptyData.data.length, 0);
  assert.equal(emptyData.analysisProfile.type, 'BANK');
  assert.equal((await fetch(base + '/api/companies/O/specialized-metrics')).status, 400);
  report.querySemantics = 'PASS'; report.rowsWritten = DB.metrics.rows_written; assert.equal(report.rowsWritten, 0);
  save(); await delay(30000);
  report.cpu = await collectCpu(report, observabilityToken());
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  save(); console.log(JSON.stringify({ step: 'production-final', existingApi: report.existingApi,
    semantics: report.querySemantics, requests: report.samples.length, rowsWritten: report.rowsWritten,
    cpu: report.cpu?.verdict, cpuStats: report.cpu?.cpu, error: report.error }));
  if (report.cpu?.verdict !== 'PASS') process.exitCode = 1;
}
