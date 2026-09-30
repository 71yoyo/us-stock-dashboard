import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// 구현 전 31개 전체 결과를 외부 cache에 한 번만 고정한다. 새 결과로 재기준화하지 않는다.
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 1), ['--read-only-cache']); assert.equal(args.length, 2);
const cache = resolve(args[1]), repo = fileURLToPath(new URL('..', import.meta.url));
assert.ok(relative(repo, cache).startsWith('..'), 'cache는 repo 밖이어야 합니다.');
const input = JSON.parse(readFileSync(join(cache, 'dry-run-results.json'), 'utf8'));
const path = join(cache, 'p5ca-regression-baseline.json');
if (!existsSync(path)) {
  assert.deepEqual(input.summary.statuses, { VERIFIED_PARSED:9, PARSED:22, NEEDS_REVIEW:3, UNKNOWN_FORMAT:6,
    WRONG_ISSUER:0, SOURCE_UNAVAILABLE:0, PARSER_ERROR:0 });
  const rows = input.rows.filter(row => ['VERIFIED_PARSED', 'PARSED'].includes(row.final_status));
  assert.equal(rows.length, 31);
  writeFileSync(path, JSON.stringify({ checkpoint:'99592cc92a2fe08d33f84881f9e76643b06ae88f', rows }, null, 2), { flag:'wx' });
}
const baseline = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(baseline.rows.length,31);
for (const row of baseline.rows) assert.deepEqual(input.rows.find(r => r.id === row.id), row, '[REGRESSION BLOCKER] 기존 31개 변경');
console.log('31개 전체 결과 불변 baseline: PASS (repo 밖, 재다운로드 없음)');
