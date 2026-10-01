import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { summarize } from './realty-income-p5b-core.mjs';

// 기존 cache를 승인된 read-only audit 경로로 다시 파싱한다. 이 도구에는 네트워크 기능이 없다.
export function loadHistoricalCache(cachePath) {
  const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const cache = realpathSync(resolve(cachePath));
  const location = relative(repo, cache);
  assert.ok(location === '..' || location.startsWith('..' + sep), '기존 source cache를 repo 밖 경로로 지정해 주세요.');
  execFileSync(process.execPath, [join(repo, 'scripts/realty-income-p5b-audit.mjs'), '--read-only-cache', cache],
    { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const input = JSON.parse(readFileSync(join(cache, 'dry-run-results.json'), 'utf8'));
  const inventory = readFileSync(join(repo, 'tests/fixtures/realty-income-p5a/inventory.json'));
  assert.equal(input.inventory_hash, createHash('sha256').update(inventory).digest('hex'));
  for (const row of input.rows) {
    assert.ok(['PARSED', 'VERIFIED_PARSED'].includes(row.final_status), `미승인 source: ${row.id}`);
    assert.match(row.id, /^\d{4}-q[1-4]$/);
    const bytes = readFileSync(join(cache, row.id + '.pdf'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.source_hash, `원문 hash 불일치: ${row.id}`);
  }
  assert.deepEqual(summarize(input.rows), input.summary, 'cache 결과 통계 불일치');
  return { rows: input.rows, summary: input.summary, cache, sourceHashesVerified: input.rows.length };
}
