import { createHash } from 'node:crypto';

export const SERIES = ['quarterly', 'annual', 'ytd'].flatMap((periodScope, index) =>
  ['FFO', 'AFFO', 'NORMALIZED_FFO'].map((metricCode, metricIndex) => ({
    id: `${periodScope}-${metricCode.toLowerCase().replaceAll('_', '-')}`,
    query: { ticker: 'O', metricCode, periodScope, valueBasis: 'per_share', shareBasis: 'diluted' },
    expected: [[40, 40, 19], [10, 10, 5], [20, 20, 10]][index][metricIndex]
  })));

// 키 순서만 정규화한다. 숫자/출처/검증 상태/정의 경계는 단 하나도 제거하지 않는다.
export function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableObject(value[key])]));
  return value;
}
export const semanticHash = value => createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');

export function previewConfig({ accountId, dbId, dbName, workerName, authHash, expiresAt, main }) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9-]{36}$/.test(dbId)
    || dbName !== 'us-stock-dashboard-p75-rehearsal-20261001'
    || !/^us-stock-p77-gate-[a-z0-9-]+$/.test(workerName)
    || !/^[a-f0-9]{64}$/.test(authHash)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3600000
    || dbId === '698ab9b8-4573-40c7-b119-d7b1d681abc8') throw new Error('P7.7 격리 대상 guard 실패');
  return { name: workerName, main, account_id: accountId, compatibility_date: '2026-09-21',
    workers_dev: false, preview_urls: true,
    previews: { d1_databases: [{ binding: 'P77_READ_ONLY', database_id: dbId, database_name: dbName }],
      vars: { P77_PRIVATE_ONLY: 'YES', P77_AUTH_HASH: authHash, P77_EXPIRES_AT: String(expiresAt) },
      observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true } } } };
}

export function verifyResponse(data, series, expectedHash) {
  if (data?.data?.length !== series.expected || data.economicContinuityAssumed !== false
    || !Array.isArray(data.definitionBoundaries)
    || data.data.some(row => !Number.isFinite(row.value) || !row.unit || !row.definitionVersion || !row.validationStatus)
    || semanticHash(data) !== expectedHash) throw new Error('P7.7 response semantic 불일치');
}

export function statistics(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

// 선택한 측정 표본은 전부 Cloudflare 실제 invocation과 대응해야 한다.
export function cpuVerdict(samples, requiredCount) {
  if (samples.length !== requiredCount || samples.some(row => !Number.isFinite(row.cpuTimeMs)
    || !Number.isFinite(row.wallTimeMs) || !row.outcome)) return 'NOT VERIFIED';
  if (samples.some(row => row.outcome !== 'ok' || row.cpuTimeMs > 10)) return 'FAIL';
  // 10ms 직전 표본은 통과로 과장하지 않는다. 운영 앱 전체 비용은 P8 smoke에서 별도 확인한다.
  return statistics(samples.map(row => row.cpuTimeMs)).max >= 9 ? 'FAIL' : 'PASS';
}

export function correlateCpu(reports, invocations) {
  const expected = new Map(reports.flatMap(report => report.samples.map(sample => [sample.probeId, sample])));
  const seen = new Set();
  const grouped = new Map(SERIES.map(series => [series.id, []]));
  const rejected = [];
  let warmups = 0;
  for (const row of invocations) {
    const sample = expected.get(row.probeId);
    if (!sample || seen.has(row.probeId) || !Number.isFinite(row.cpuTimeMs)
      || !Number.isFinite(row.wallTimeMs) || row.cpuTimeMs < 0 || row.wallTimeMs < 0) {
      rejected.push(row.probeId || 'unknown'); continue;
    }
    seen.add(row.probeId);
    if (sample.warmup) { warmups++; continue; }
    grouped.get(sample.series).push(row);
  }
  const coverage = Object.fromEntries([...grouped].map(([series, rows]) => [series, {
    samples: rows.length, cpu: statistics(rows.map(row => row.cpuTimeMs)),
    wall: statistics(rows.map(row => row.wallTimeMs)),
    outcomeErrors: rows.filter(row => row.outcome !== 'ok').length
  }]));
  const measured = [...grouped.values()].flat();
  const enough = [...grouped.values()].every(rows => rows.length >= 10);
  return { matched: seen.size, warmups, missing: [...expected.keys()].filter(id => !seen.has(id)), rejected,
    coverage, cpu: statistics(measured.map(row => row.cpuTimeMs)), wall: statistics(measured.map(row => row.wallTimeMs)),
    verdict: rejected.length || !enough ? 'NOT VERIFIED' : cpuVerdict(measured, measured.length) };
}
