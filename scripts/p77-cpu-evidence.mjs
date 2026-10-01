import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { correlateCpu, semanticHash } from './p77-gate-core.mjs';

const argumentsList = process.argv.slice(2);
const tokenIndex = argumentsList.indexOf('--token-file');
if (tokenIndex < 0 || !argumentsList[tokenIndex + 1]) throw new Error('Git 제외된 --token-file을 지정해 주세요.');
const tokenPath = resolve(argumentsList[tokenIndex + 1]);
if (!tokenPath.startsWith(resolve('worker') + '\\') || !/^\.dev\.vars(?:\..+)?$/.test(basename(tokenPath))) {
  throw new Error('worker 내부의 Git 제외 환경 파일만 사용할 수 있습니다.');
}
// credential을 읽기 전에 반드시 추적 제외 여부를 확인한다. 원문·길이·hash는 출력하지 않는다.
execFileSync('git', ['check-ignore', '--', tokenPath], { stdio: 'pipe' });
if (execFileSync('git', ['ls-files', '--', tokenPath], { encoding: 'utf8', stdio: 'pipe' }).trim()) {
  throw new Error('민감 설정 파일이 Git에 추적되어 있어 중단합니다.');
}
const token = readFileSync(tokenPath, 'utf8').match(/^\s*CLOUDFLARE_OBSERVABILITY_API_TOKEN\s*=\s*(.+)$/m)
  ?.[1]?.trim().replace(/^['"]|['"]$/g, '');
if (!token) throw new Error('CPU 조회용 환경변수를 확인해 주세요.');
const reportPaths = argumentsList.filter((_, index) => index !== tokenIndex && index !== tokenIndex + 1);
if (!reportPaths.length || reportPaths.some(path => !resolve(path).startsWith(resolve('backups/p77') + '\\'))) {
  throw new Error('backups/p77의 기존 runtime 결과를 지정해 주세요.');
}
const reports = reportPaths.map(path => JSON.parse(readFileSync(path, 'utf8')));
if (reports.some(report => report.cleanup !== 'PASS' || report.querySemantics !== 'PASS'
  || !/^us-stock-p77-gate-[a-z0-9-]+$/.test(report.workerName)
  || semanticHash(report.baseline) !== semanticHash(reports[0].baseline))) throw new Error('runtime 증거 무결성 검증 실패');
const rows = [];
const queries = [];
for (const report of reports) {
  const response = await fetch('https://api.cloudflare.com/client/v4/accounts/3b11130d1e729d56312f9ae504becc60/workers/observability/telemetry/query', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queryId: `p77-cpu-${report.runId}`, timeframe: {
      from: Date.parse(report.startedAt) - 1000, to: Date.now() }, view: 'events', limit: 1000, dry: true,
      parameters: { filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: report.workerName }] } }),
    signal: AbortSignal.timeout(45000)
  });
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(`실제 CPU 조회 거부: HTTP ${response.status}`);
  const events = json.result?.events?.events;
  if (!Array.isArray(events) || events.length >= 1000) throw new Error('CPU 로그 누락/페이지 제한: PASS 금지');
  let matched = 0;
  for (const event of events) {
    const invocation = event.$workers;
    const probeId = invocation?.event?.request?.headers?.['x-p77-probe'];
    if (!report.samples.some(sample => sample.probeId === probeId)) continue;
    if (invocation.scriptName !== report.workerName || invocation.preview?.id !== report.previewId
      || !Number.isFinite(invocation.cpuTimeMs)) throw new Error('CPU invocation identity 불일치');
    rows.push({ probeId, cpuTimeMs: invocation.cpuTimeMs, wallTimeMs: invocation.wallTimeMs, outcome: invocation.outcome });
    matched++;
  }
  queries.push({ workerName: report.workerName, httpStatus: response.status, matched });
}
const evidence = { phase: 'P7.7', source: 'Cloudflare Workers Observability actual invocation',
  checkedAt: new Date().toISOString(), credentialPrinted: false, queries, ...correlateCpu(reports, rows) };
writeFileSync('backups/p77/cpu-evidence.json', JSON.stringify({ ...evidence, samples: rows }, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (evidence.verdict !== 'PASS') process.exitCode = 1;
