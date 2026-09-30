import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyInventory, auditDocument, summarize, deduplicate, comparisons, metricCoverage, FINAL_STATUSES } from '../scripts/realty-income-p5b-core.mjs';
import { p5aDocument, p5aResults, inventoryFixture } from './helpers/realty-income-p5a-fixtures.js';
import { historicalResults } from './helpers/realty-income-historical-fixtures.js';
import { officialResults } from './helpers/realty-income-fixtures.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';

const inventory = () => structuredClone(inventoryFixture().documents);
test('P5B 전체 40개 공개 metadata 결과와 상태/coverage 통계 일치', () => {
  const { summary, rows } = JSON.parse(readFileSync(new URL('../docs/realty-income-phase-p5b-results.json', import.meta.url), 'utf8'));
  assert.equal(rows.length, 40);
  assert.deepEqual(rows.map(row => row.source_url), inventory().map(row => row.source_url));
  assert.ok(rows.every(row => row.http_status === 200 && row.period_verified && /^[a-f0-9]{64}$/.test(row.source_hash)));
  for (const status of FINAL_STATUSES) assert.equal(summary.statuses[status], rows.filter(row => row.final_status === status).length);
  assert.deepEqual(summary.statuses, { VERIFIED_PARSED: 9, PARSED: 8, NEEDS_REVIEW: 6, UNKNOWN_FORMAT: 17, WRONG_ISSUER: 0, SOURCE_UNAVAILABLE: 0, PARSER_ERROR: 0 });
  assert.equal(summary.quarterly.metrics.NORMALIZED_FFO.confirmed_reported_opportunities, rows.filter(row => row.normalized_ffo === 'YES').length);
  assert.equal(summary.quarterly.metrics.FFO['total/not_applicable'], 17);
  assert.equal(summary.annual.metrics.FFO['total/not_applicable'], 2);
  assert.equal(summary.dedup.observations, 564);
  assert.equal(summary.dedup.unique_values, 464);
  assert.equal(summary.dedup.provenance, 564);
  assert.equal(summary.comparison.exact_match, 100);
  // metadata snapshot은 fixture 숫자를 보정하는 수단이 아니며 numeric row/원문 자체를 담지 않는다.
  assert.ok(rows.every(row => !('records' in row) && !('definitions' in row) && !('text' in row)));
});
function sample(id = '2017-q1') {
  const document = p5aDocument(id), row = inventory().find(row => row.source_url === document.source.source_url);
  return { row, document, inspection: { download: { source_url: row.source_url, source_hash: document.source.source_hash, http_status: 200,
    error: null, retrieved_at: document.source.retrieved_at }, page_count: document.source.page_count, identity_text: document.excerpt.identity_text,
    document_title: document.excerpt.document_title, candidate_tables: document.excerpt.pages, definition_excerpts: document.excerpt.definition_excerpts,
    filed_at: document.source.filed_at, error: null } };
}
const emptyRows = () => inventory().map(row => ({ id: `${row.year}-q${row.quarter}`, year: row.year, quarter: row.quarter,
  final_status: 'SOURCE_UNAVAILABLE', source_status: 'UNAVAILABLE', normalized_ffo: 'UNKNOWN', detected_format: null, records: [] }));
async function resultRow(id, index) {
  const { row } = sample(id), result = (await p5aResults())[index];
  return { ...row, id, final_status: 'PARSED', source_status: 'AVAILABLE', detected_format: result.format,
    normalized_ffo: result.records.some(row => row.metric_code === 'NORMALIZED_FFO') ? 'YES' : 'NO', records: result.records };
}

test('P5B inventory 40개 고유 period와 URL만 허용', () => { assert.equal(verifyInventory(inventory()).length, 40); });
test('P5B duplicate inventory key/URL 및 39개 범위 거부', () => {
  assert.throws(() => verifyInventory(inventory().slice(1)), /40개/);
  const rows = inventory(); rows[1] = rows[0]; assert.throws(() => verifyInventory(rows), /중복/);
});
test('P5B 임의 URL/타 issuer/잘못된 CIK 수집 대상 거부', () => {
  for (const action of [row => row.source_url = 'https://example.com/a.pdf', row => row.issuer = 'VEREIT', row => row.CIK = '1']) {
    const rows = inventory(); action(rows[0]); assert.throws(() => verifyInventory(rows), /inventory/);
  }
});
test('P5B all inventory visited: 40개 결과 및 status 합계', () => {
  const rows = emptyRows(), summary = summarize(rows); assert.equal(summary.visited, 40);
  assert.equal(Object.values(summary.statuses).reduce((a, b) => a + b), 40);
  assert.throws(() => summarize(rows.slice(1)), /40개/);
});
test('P5B 최종 상태 누락/잘못된 상태는 40개 통계 확정 금지', () => {
  const rows = emptyRows(); rows[0].final_status = 'PENDING';
  assert.throws(() => summarize(rows), /최종 상태/);
});
test('P5B 신규 문서 공시일 미확인은 임의 날짜 없이 차단', async () => {
  const { row, inspection } = sample(); inspection.filed_at = null;
  const result = await auditDocument(row, inspection);
  assert.equal(result.final_status, 'NEEDS_REVIEW');
  assert.equal(result.errors[0].code, 'PUBLICATION_DATE_UNCONFIRMED');
  assert.equal(result.records.length, 0);
});
test('P5B source unavailable이면 후속 parser/값 생성 없음', async () => {
  const { row, inspection } = sample(); inspection.download.http_status = 404; inspection.download.error = 'HTTP 404';
  const result = await auditDocument(row, inspection); assert.equal(result.final_status, 'SOURCE_UNAVAILABLE');
  assert.equal(result.parser_status, 'NOT_RUN'); assert.deepEqual(result.records, []);
});
test('P5B 원문 hash 누락 및 changed source는 parser 전에 차단', async () => {
  const { row, document, inspection } = sample();
  const changed = structuredClone(inspection); changed.download.source_hash = 'a'.repeat(64);
  const result = await auditDocument(row, changed, { document }); assert.equal(result.source_changed, true);
  assert.equal(result.errors[0].code, 'SOURCE_CHANGED'); assert.equal(result.records.length, 0);
  inspection.download.source_hash = null; assert.equal((await auditDocument(row, inspection)).errors[0].code, 'SOURCE_HASH_MISSING');
});
test('P5B unknown format은 안전 차단하고 숫자 row가 없다', async () => {
  const { row, inspection } = sample(); inspection.document_title = '새로운 알 수 없는 문서';
  const result = await auditDocument(row, inspection); assert.equal(result.final_status, 'UNKNOWN_FORMAT'); assert.equal(result.records.length, 0);
});
test('P5B wrong issuer는 rejected 의미로 분류하고 합병 언급은 허용', async () => {
  const { row, inspection } = sample('2022-q3'); inspection.identity_text = 'VEREIT (NYSE: VER)';
  assert.equal((await auditDocument(row, inspection)).final_status, 'WRONG_ISSUER');
  const fresh = sample('2022-q3'); assert.equal((await auditDocument(fresh.row, fresh.inspection)).final_status, 'PARSED');
});
test('P5B identity 누락은 다른 회사로 단정하지 않고 needs_review', async () => {
  const { row, inspection } = sample(); inspection.identity_text = null;
  assert.equal((await auditDocument(row, inspection)).final_status, 'NEEDS_REVIEW');
});
test('P5B period footer 불일치면 parser 전에 중단', async () => {
  const { row, inspection } = sample(); inspection.candidate_tables[0].text = inspection.candidate_tables[0].text.replace('Q1 2017 Supplemental', 'Q2 2017 Supplemental');
  const result = await auditDocument(row, inspection); assert.equal(result.final_status, 'NEEDS_REVIEW'); assert.equal(result.records.length, 0);
});
test('P5B 신규 parser 성공은 parsed이며 자동 validated 승격 없음', async () => {
  const { row, inspection } = sample(); const result = await auditDocument(row, inspection);
  assert.equal(result.final_status, 'PARSED'); assert.equal(result.records.length, 12);
  assert.ok(result.records.every(row => row.validation_status === 'parsed'));
});
test('P5B 공시 basis와 미공시 basis는 숫자 row 생성 없이 별도 조사', async () => {
  const legacy = sample(); const earlier = await auditDocument(legacy.row, legacy.inspection);
  assert.equal(earlier.basis_disclosure.FFO['total/diluted'], 'not_reported');
  assert.equal(earlier.basis_disclosure.FFO['per_share/diluted'], 'reported');
  assert.ok(Object.values(earlier.basis_disclosure.NORMALIZED_FFO).every(value => value === 'not_reported'));
  const later = sample('2022-q3'); const current = await auditDocument(later.row, later.inspection);
  assert.ok(Object.values(current.basis_disclosure.NORMALIZED_FFO).every(value => value === 'reported'));
  const wrapped = sample('2018-q3'); const mixed = await auditDocument(wrapped.row, wrapped.inspection);
  assert.equal(mixed.basis_disclosure.AFFO['total/not_applicable'], 'reported');
});
test('P5B 기존 validated/parsed/정의/출처 결과를 그대로 보존', async () => {
  const { row, document, inspection } = sample(); const result = (await p5aResults())[0];
  const fresh = await auditDocument(row, inspection, { document, result, parse: async () => (await p5aResults())[0] });
  assert.equal(fresh.final_status, 'VERIFIED_PARSED'); assert.deepEqual(fresh.records, result.records); assert.deepEqual(fresh.definitions, result.definitions);
});
test('P5B 단위 mismatch는 fail-closed', async () => {
  const { row, inspection } = sample(); inspection.candidate_tables[0].text = inspection.candidate_tables[0].text.replace('in thousands', 'in millions');
  const result = await auditDocument(row, inspection); assert.equal(result.final_status, 'NEEDS_REVIEW'); assert.equal(result.records.length, 0);
});
test('P5B semantic equivalent 제목 대소문자/각주만 정규화', async () => {
  const { row, inspection } = sample(); inspection.candidate_tables[0].text = inspection.candidate_tables[0].text.replace('Funds From Operations (FFO)', 'FUNDS FROM OPERATIONS (FFO)');
  const result = await auditDocument(row, inspection); assert.equal(result.final_status, 'PARSED'); assert.equal(result.records.length, 12);
});
test('P5B 파싱 단계 모호함과 예기치 않은 parser error는 구별', async () => {
  const { row, inspection } = sample(); inspection.definition_excerpts = [];
  const review = await auditDocument(row, inspection); assert.equal(review.final_status, 'NEEDS_REVIEW');
  const good = sample(); good.inspection.page_count = undefined;
  // 명백한 계약 오류를 합성하여 오류 상태를 확인한다. 실제 문서 오류로 주장하지 않는다.
  const result = await auditDocument(good.row, good.inspection, { document: good.document, result: (await p5aResults())[0], parse: async () => { throw new Error('합성 parser failure'); } });
  assert.equal(result.final_status, 'PARSER_ERROR');
});
test('P5B 동일 값 row 하나와 복수 provenance; 172 → 148 → 172', async () => {
  const results = await p5aResults(); const rows = results.map((result, index) => ({ ...emptyRows()[index], final_status: 'PARSED', records: result.records }));
  const merged = deduplicate(rows); assert.equal(merged.observations, 172); assert.equal(merged.unique_values, 148); assert.equal(merged.provenance, 172);
  assert.equal(merged.conflicts.length, 0);
});
test('P5B conflict는 양쪽 값/출처 보존, canonical 정답 선택 및 overwrite 금지', async () => {
  const original = await resultRow('2022-q3', 3), later = await resultRow('2023-q3', 4);
  later.records = structuredClone(later.records); const changed = later.records.find(row => row.fiscal_year === 2022 && row.value_basis === 'total');
  changed.raw_value += 1; changed.canonical_value += 1000;
  const merged = deduplicate([original, later]); assert.equal(merged.conflicts.length, 1); assert.equal(merged.conflicts[0].overwrite, false);
  assert.equal(merged.conflicts[0].variants.length, 2); assert.equal(merged.conflicts[0].delta, 1000);
  assert.equal(merged.unique_values, merged.unique_keys - 1);
});
test('P5B 비교연도 24개 exact match; 합성 차이는 difference', async () => {
  const original = await resultRow('2022-q3', 3), later = await resultRow('2023-q3', 4);
  assert.deepEqual(comparisons([original, later]), { comparable: 24, exact_match: 24, difference: 0, restated_candidates: [] });
  later.records = structuredClone(later.records); later.records.find(row => row.fiscal_year === 2022).canonical_value += 1000;
  assert.equal(comparisons([original, later]).difference, 1);
});
test('P5B primary quarter만 coverage; comparison/YTD를 분자에 더하지 않음', async () => {
  const row = await resultRow('2022-q3', 3), coverage = metricCoverage([row], 'quarterly');
  assert.equal(coverage.opportunities, 1); assert.equal(coverage.metrics.FFO['total/not_applicable'], 1);
  assert.equal(coverage.metrics.NORMALIZED_FFO.confirmed_reported_opportunities, 1);
});
test('P5B annual 분모 10, Q4 quarter와 annual 분리', async () => {
  const rows = emptyRows(); const result = (await historicalResults())[0];
  rows[3] = { ...rows[3], final_status: 'VERIFIED_PARSED', normalized_ffo: 'NO', records: result.records };
  const annual = metricCoverage(rows, 'annual'); assert.equal(annual.opportunities, 10); assert.equal(annual.metrics.FFO['per_share/diluted'], 1);
  assert.equal(metricCoverage(rows, 'quarterly').metrics.FFO['per_share/diluted'], 1);
});
test('P5B support matrix와 format/year 통계 합계 40', async () => {
  const rows = emptyRows(); rows[4] = await resultRow('2017-q1', 0);
  const summary = summarize(rows); assert.equal(summary.formats.reduce((sum, row) => sum + row.documents, 0), 40);
  assert.equal(summary.years.length, 10); assert.ok(summary.years.every(row => row.documents === 4)); assert.equal(FINAL_STATUSES.length, 7);
});
test('P5B 신규 audit 문서는 production 승인 manifest로 승격되지 않음', async () => {
  const { document } = sample(); document.source.source_url = inventory()[0].source_url;
  assert.equal((await parseRealtyIncomeDocument(document)).status, 'needs_review');
});
test('P5B core에는 네트워크/DB 쓰기/저장모듈 의존이 없음', () => {
  const core = readFileSync(new URL('../scripts/realty-income-p5b-core.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|\bwriteFile|saveSpecializedMetrics|wrangler|\.prepare\s*\(/.test(core));
});
test('P5B P3/P4/P5A baseline 396 key/14 definitions/420 provenance 및 expected 36 불변', async () => {
  const p3 = await officialResults(), p4 = await historicalResults(), p5 = await p5aResults();
  assert.equal(p3.flatMap(row => row.records).length, 96); assert.equal(p3.flatMap(row => row.records).filter(row => row.validation_status === 'validated').length, 36);
  assert.equal([...p3, ...p4].flatMap(row => row.records).length, 248);
  const records = [...p3, ...p4, ...p5].flatMap(row => row.records); assert.equal(records.length, 420);
  assert.equal(new Set(records.map(metricRecordKey)).size, 396);
  const definitions = [...p3, ...p4, ...p5].flatMap(row => row.definitions);
  assert.equal(new Set(definitions.map(row => `${row.metric_code}|${row.definition_owner}|${row.definition_version}`)).size, 14);
});
