import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { verifyInventory, auditDocument, summarize } from './realty-income-p5b-core.mjs';
import { historicalDocument, historicalIds, historicalResults } from '../tests/helpers/realty-income-historical-fixtures.js';
import { p5aIds, p5aDocument, p5aResults } from '../tests/helpers/realty-income-p5a-fixtures.js';

// 네트워크/DB/운영 설정을 받지 않는다. 원문 cache에서 읽고 같은 외부 cache에 결과만 기록한다.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--read-only-cache') throw new Error('--read-only-cache <repo 밖 cache>만 허용합니다.');
const repo = fileURLToPath(new URL('..', import.meta.url)), cache = resolve(args[1]);
if (!relative(repo, cache).startsWith('..')) throw new Error('cache는 repo 밖이어야 합니다.');
const inventory = verifyInventory(JSON.parse(readFileSync(new URL('../tests/fixtures/realty-income-p5a/inventory.json', import.meta.url), 'utf8')).documents);
const inspections = JSON.parse(readFileSync(join(cache, 'inspections.json'), 'utf8'));
assert.equal(inspections.length, 40);
assert.equal(new Set(inspections.map(row => row.download.id)).size, 40);
const oldHistorical = await historicalResults(), oldP5a = await p5aResults();
const known = new Map();
for (const [index, id] of historicalIds.entries()) {
  const document = historicalDocument(id);
  known.set(document.source.source_url, { document, result: oldHistorical[index], parse: async () => (await historicalResults())[index] });
}
for (const [index, id] of p5aIds.entries()) {
  const document = p5aDocument(id);
  known.set(document.source.source_url, { document, result: oldP5a[index], parse: async () => (await p5aResults())[index] });
}
const rows = [];
for (const row of inventory) {
  const inspection = inspections.find(item => item.download.source_url === row.source_url);
  assert.ok(inspection, 'inventory source 결과 누락');
  if (!inspection.download.error) {
    const bytes = readFileSync(join(cache, `${row.year}-q${row.quarter}.pdf`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), inspection.download.source_hash, 'cache 원문 hash 불일치');
  }
  const result = await auditDocument(row, inspection, known.get(row.source_url));
  rows.push(result);
  console.log(result.id, result.final_status, result.detected_format || 'UNKNOWN', result.records.length, result.errors.map(error => error.code).join(','));
}
const summary = summarize(rows);
const knownRows = rows.filter(row => known.has(row.source_url));
assert.equal(knownRows.length, 9);
assert.ok(knownRows.every(row => row.final_status === 'VERIFIED_PARSED'), '[REGRESSION BLOCKER] 기존 9개 재검증 실패');
writeFileSync(join(cache, 'dry-run-results.json'), JSON.stringify({ scope: 'read-only; not approved for persistence', inventory_hash:
  createHash('sha256').update(readFileSync(new URL('../tests/fixtures/realty-income-p5a/inventory.json', import.meta.url))).digest('hex'),
  summary, rows }, null, 2));
// 최종 보고용 metadata/statistics만 따로 보존한다. 전체 원문/값 row backfill 파일이 아니다.
writeFileSync(join(cache, 'dry-run-summary.json'), JSON.stringify({ summary, rows: rows.map(({ records, definitions, ...row }) => ({ ...row,
  record_count: records.length, validated_count: records.filter(record => record.validation_status === 'validated').length,
  definition_versions: definitions.map(definition => definition.definition_version),
  source_pages: [...new Set(records.map(record => record.sources[0].page_number))] })) }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('production migration/write/deploy/UI/backfill/commit/push 모두 NO');
