import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// 확장 전 P5B 결과를 repo 밖에 고정한다. 원문 재다운로드/DB 저장 없이 deep regression 비교에만 사용한다.
const args = process.argv.slice(2);
assert.equal(args.length, 2); assert.equal(args[0], '--read-only-cache');
const cache = resolve(args[1]), repo = fileURLToPath(new URL('..', import.meta.url));
assert.ok(relative(repo, cache).startsWith('..'), 'cache는 repo 밖이어야 합니다.');
const input = JSON.parse(readFileSync(join(cache, 'dry-run-results.json'), 'utf8'));
assert.deepEqual(input.summary.statuses, { VERIFIED_PARSED:9, PARSED:8, NEEDS_REVIEW:6, UNKNOWN_FORMAT:17, WRONG_ISSUER:0, SOURCE_UNAVAILABLE:0, PARSER_ERROR:0 });
const rows = input.rows.filter(row => ['VERIFIED_PARSED', 'PARSED'].includes(row.final_status));
assert.equal(rows.length, 17);
const path = join(cache, 'p5b-regression-baseline.json');
if (!existsSync(path)) writeFileSync(path, JSON.stringify({ checkpoint:'05c68bd7164334f4e8e78af8b28e05013cf532cd', rows }, null, 2), { flag:'wx' });
assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rows, rows);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
console.log(JSON.stringify(rows.map(row => ({id:row.id, status:row.final_status, format:row.detected_format,
  source_hash:row.source_hash, record_count:row.records.length, records_digest:digest(row.records), definitions_digest:digest(row.definitions)})), null, 2));
