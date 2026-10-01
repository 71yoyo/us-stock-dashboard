import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadHistoricalCache } from './realty-income-p6-input.mjs';
import { runHistoricalStorageAudit } from './realty-income-p6-core.mjs';
import { stableData, hash } from './specialized-disposable-db.mjs';

// 생성 시각과 외부 cache 경로는 의미 hash에서 제외하되 승인 원문 hash는 절대 변경하지 않는다.
export const semanticArtifact = artifact => stableData({ datasetVersion: artifact.datasetVersion,
  parserCommit: artifact.parserCommit, documents: artifact.documents, expected: artifact.expected });
export function sanitizeDocument(row) {
  const { definitions, records, id, url, source_hash, final_status, format } = row;
  return { id, url: url || records[0].sources[0].source_url, source_hash, issuer: 'Realty Income Corporation',
    cik: '0000726728', period: id, format: format || row.format_detected || null, final_status, definitions, records };
}
if (process.argv[1] === resolve('scripts/p75-artifact.mjs')) {
  const cache = process.argv[2]; assert.ok(cache, '기존 repo 밖 cache가 필요합니다.');
  const parserCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(parserCommit, 'c6fbf35afe208eb74eca92afcdc9d523fa69ef11');
  const approved = JSON.parse(readFileSync('docs/realty-income-phase-p5cb2-results.json', 'utf8'));
  const builds = [];
  for (let index = 0; index < 2; index++) {
    const input = loadHistoricalCache(cache);
    const baseline = JSON.parse(readFileSync(join(cache, 'p5cb1-regression-baseline.json'), 'utf8'));
    const approvedRows = [...baseline.rows, ...approved.modern_documents];
    assert.ok(approvedRows, '승인된 source hash 목록이 없습니다.');
    for (const row of input.rows) assert.equal(row.source_hash, approvedRows.find(item => item.id === row.id)?.source_hash);
    const audit = await runHistoricalStorageAudit(input.rows);
    const approvedP6 = JSON.parse(readFileSync('docs/realty-income-phase-p6-results.json', 'utf8'));
    assert.deepEqual(audit.run1, approvedP6.run1, '승인된 P6 semantic digest 변경: artifact 생성 중단');
    builds.push({ datasetVersion: 'realty-income-2016-2025-p75-v1', parserCommit, generatedAt: new Date().toISOString(),
      documents: input.rows.map(sanitizeDocument), expected: audit.run1 });
  }
  assert.equal(hash(semanticArtifact(builds[0])), hash(semanticArtifact(builds[1])));
  assert.equal(builds[0].documents.length, 40);
  const serialized = JSON.stringify(builds[0]);
  const checkStrings = value => {
    if (typeof value === 'string') assert.ok(!/\b[A-Za-z]:[\\/]|AppData|@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value), 'artifact에 개인 정보/로컬 경로가 있습니다.');
    else if (value && typeof value === 'object') Object.values(value).forEach(checkStrings);
  };
  checkStrings(builds[0]);
  mkdirSync('backups/p75', { recursive: true });
  const fileDigest = createHash('sha256').update(serialized).digest('hex');
  const immutablePath = `backups/p75/artifact-${fileDigest}.json`;
  if (existsSync(immutablePath)) assert.equal(readFileSync(immutablePath, 'utf8'), serialized);
  else writeFileSync(immutablePath, serialized, { flag: 'wx' });
  // 고정 이름은 로컬 실행용 복사본이다. 승인 후보의 실제 identity는 content-addressed 파일과 manifest SHA다.
  writeFileSync('backups/p75/artifact.json', JSON.stringify(builds[0]));
  const manifest = { datasetVersion: builds[0].datasetVersion, parserCommit, generatedAt: builds[0].generatedAt,
    sourceHashesVerified: 40, deterministicBuilds: 2, semanticArtifactDigest: hash(semanticArtifact(builds[0])),
    artifactFileDigest: fileDigest, artifactFile: `artifact-${fileDigest}.json`, expected: builds[0].expected,
    sources: builds[0].documents.map(({ id, url, source_hash, cik, period, format }) => ({ id, url, source_hash, cik, period, format })) };
  writeFileSync('backups/p75/manifest.json', JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ documents: 40, digest: manifest.semanticArtifactDigest, expected: manifest.expected }, null, 2));
}
