import { readFileSync, writeFileSync } from 'node:fs';
import { SERIES } from './p77-gate-core.mjs';
import { collectCpu, observabilityToken } from './p9a-audit-core.mjs';

// 토큰 수정 후 기존 preview 표본의 CPU 로그만 다시 읽는다. Worker 요청/배포/DB 쓰기는 하지 않는다.
if (process.argv.length !== 2) throw new Error('P9A 기존 CPU 증거만 읽을 수 있습니다.');
const report = JSON.parse(readFileSync('backups/p9a/preview-results.json', 'utf8'));
if (report.cleanup !== 'PASS' || report.querySemantics !== 'PASS'
  || !/^us-stock-p9a-gate-[a-z0-9-]+$/.test(report.workerName) || !report.previewId
  || new Set(report.samples.map(row => row.probeId)).size !== report.samples.length) {
  throw new Error('P9A preview 증거 무결성 검사 실패');
}
for (const series of SERIES) {
  const samples = report.samples.filter(row => row.series === series.id);
  if (samples.filter(row => !row.warmup).length !== 10 || samples.some(row => row.httpStatus !== 200
    || row.rowCount !== series.expected || row.semanticHash !== report.baseline[series.id]
    || row.d1?.queries !== 3 || row.d1?.rowsWritten !== 0)) throw new Error('P9A HTTP/DB 표본 검사 실패');
}
const evidence = await collectCpu(report, observabilityToken());
writeFileSync('backups/p9a/cpu-evidence.json', JSON.stringify({ checkedAt: new Date().toISOString(), ...evidence }, null, 2));
console.log(JSON.stringify({ verdict: evidence.verdict, httpStatus: evidence.httpStatus, cpu: evidence.cpu,
  coverage: evidence.coverage, missing: evidence.missing?.length, reason: evidence.reason }));
if (evidence.verdict !== 'PASS') process.exitCode = 1;
