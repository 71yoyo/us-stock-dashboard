import assert from 'node:assert/strict';
import { loadHistoricalCache } from './realty-income-p6-input.mjs';
import { runHistoricalStorageAudit } from './realty-income-p6-core.mjs';

// 기존 cache를 필수로 받아 외부 API·기존 DB·임의 DB 경로를 허용하지 않는다. 공개 통계만 표준 출력한다.
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--read-only-cache', '기존 repo 밖 cache를 --read-only-cache로 지정해 주세요.');
const input = loadHistoricalCache(args[1]);
const result = await runHistoricalStorageAudit(input.rows);
console.log(JSON.stringify({ ...result, sourceCache: input.cache, sourceHashesVerified: input.sourceHashesVerified }, null, 2));
