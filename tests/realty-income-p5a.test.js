import test from 'node:test';
import assert from 'node:assert/strict';
import { p5aIds, p5aDocument, p5aResults, p5aExpected, readP5a, inventoryFixture } from './helpers/realty-income-p5a-fixtures.js';
import { parseArchive, makeInventory, inventoryStatus } from '../scripts/realty-income-inventory.mjs';
import { compareObservations } from '../scripts/realty-income-comparison.mjs';
import { FORMATS, excerptHash, detectDocumentFormat } from '../worker/src/reit/realty-income-document-formats.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { historicalResults } from './helpers/realty-income-historical-fixtures.js';
import { officialResults } from './helpers/realty-income-fixtures.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';

const counts = [12, 32, 32, 48, 48];
const formats = [FORMATS.legacyJoint, FORMATS.cashMixed, FORMATS.middle, FORMATS.joint, FORMATS.normalizedAffoSeparate];
async function changed(id, action) {
  const document = p5aDocument(id); action(document);
  document.source.excerpt_hash = await excerptHash(document.excerpt);
  return parseRealtyIncomeDocument(document);
}

test('P5A inventory parsing: 40 O + 6 다른 issuer + 2026 참고 2, 모바일 반복 중복 방지', () => {
  const html = readP5a('archive-excerpt.html');
  const rows = parseArchive(html + html);
  assert.equal(rows.length, 48);
  const snapshot = inventoryFixture();
  assert.deepEqual(rows, [...snapshot.documents, ...snapshot.excluded_documents, ...snapshot.reference_documents]
    .map(({ year, quarter, archive_issuer_label, supplemental_url, earnings_url, filing_url }) =>
      ({ year, quarter, archive_issuer_label, supplemental_url, earnings_url, filing_url }))
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter || a.archive_issuer_label.localeCompare(b.archive_issuer_label)));
  for (let year = 2016; year <= 2025; year++) assert.deepEqual(snapshot.documents.filter(row => row.year === year).map(row => row.quarter), [1, 2, 3, 4]);
});
test('P5A inventory status: 원문 adapter 검증 없이 연도/다른 URL로 SUPPORTED 승격 금지', () => {
  const row = inventoryFixture().documents[0];
  assert.equal(inventoryStatus(row), 'UNKNOWN_FORMAT');
  assert.equal(inventoryStatus(row, { source_url: 'https://example.com/a.pdf', adapter_verified: true }), 'UNKNOWN_FORMAT');
  assert.equal(inventoryStatus(row, { source_url: row.source_url, adapter_verified: true }), 'SUPPORTED');
  assert.equal(inventoryStatus(row, { fingerprint_observed: true, adapter_candidate: 'candidate' }), 'LIKELY_SUPPORTED');
  assert.equal(inventoryStatus(row, { needs_review: true }), 'NEEDS_REVIEW');
  assert.equal(inventoryStatus({ ...row, supplemental_url: null }), 'MISSING');
  assert.equal(makeInventory([row])[0].published_at, null);
});
test('P5A inventory: 9개 PDF만 SUPPORTED / 미검증 31개 UNKNOWN / 타 issuer 6개 제외', () => {
  const { documents, excluded_documents, annual_relationships } = inventoryFixture();
  assert.equal(documents.filter(row => row.status === 'SUPPORTED').length, 9);
  assert.equal(documents.filter(row => row.status === 'UNKNOWN_FORMAT').length, 31);
  assert.ok(excluded_documents.every(row => row.status === 'WRONG_ISSUER' && row.CIK === null));
  assert.equal(annual_relationships.length, 10);
  assert.ok(documents.filter(row => row.status === 'UNKNOWN_FORMAT').every(row => row.normalized_ffo === 'UNKNOWN' && row.accession === null && row.available === null));
});

for (const [index, id] of p5aIds.entries()) {
  test(`P5A ${id}: 복수 fingerprint 및 정확한 generation`, async () => {
    const detection = await detectDocumentFormat(p5aDocument(id));
    assert.equal(detection.status, 'detected'); assert.equal(detection.format, formats[index]);
  });
  test(`P5A ${id}: 시각 확인한 공식 current-year expected만 validated`, async () => {
    const result = (await p5aResults())[index];
    assert.equal(result.records.length, counts[index]);
    assert.equal(p5aExpected(id).fixture.records.length, counts[index] / 2);
    assert.equal(result.records.filter(row => row.validation_status === 'validated').length, counts[index] / 2);
    assert.equal(result.records.filter(row => row.validation_status === 'parsed').length, counts[index] / 2);
    assert.equal(new Set(result.records.map(metricRecordKey)).size, counts[index]);
  });
}

test('P5A Q1: 2017/2016 Jan1-Mar31 단일 그룹, YTD 중복 행 없음', async () => {
  const result = await parseRealtyIncomeDocument(p5aDocument('2017-q1'));
  assert.equal(result.records.length, 12);
  assert.ok(result.records.every(row => row.period_scope === 'quarterly' && row.period_start.endsWith('-01-01') && row.period_end.endsWith('-03-31')));
  assert.ok(result.records.filter(row => row.value_basis === 'per_share').every(row => row.sources[0].share_disclosure === 'basic_and_diluted_joint'));
});
for (const id of p5aIds.slice(1)) test(`P5A ${id}: Q3 Jul1-Sep30 / 9M Jan1-Sep30 분리`, async () => {
  const result = await parseRealtyIncomeDocument(p5aDocument(id));
  assert.ok(result.records.filter(row => row.period_scope === 'quarterly').every(row => row.period_start.endsWith('-07-01')));
  assert.ok(result.records.filter(row => row.period_scope === 'ytd').every(row => row.period_start.endsWith('-01-01')));
  assert.ok(result.records.every(row => row.period_end.endsWith('-09-30')));
  assert.deepEqual([...new Set(result.records.map(row => row.period_scope))].sort(), ['quarterly', 'ytd']);
});
test('P5A 표 구조 전환: 2018 FFO joint/AFFO separate, 2023 Normalized joint/AFFO separate', async () => {
  for (const id of ['2018-q3', '2023-q3']) {
    const result = await parseRealtyIncomeDocument(p5aDocument(id));
    for (const row of result.records.filter(row => row.value_basis === 'per_share')) assert.equal(row.sources[0].share_disclosure,
      row.metric_code === 'AFFO' ? 'separate' : 'basic_and_diluted_joint');
  }
});
test('P5A 단위: 2022 share-count 예외는 shares, 2023 thousand; 주당값 역산 없음', async () => {
  for (const [id, unit] of [['2022-q3', 'shares'], ['2023-q3', 'shares thousand']]) {
    const result = await parseRealtyIncomeDocument(p5aDocument(id));
    assert.ok(result.records.every(row => row.sources[0].weighted_share_count_raw_unit === unit));
    assert.ok(result.records.every(row => row.raw_unit_multiplier === (row.value_basis === 'total' ? 1000 : 1)));
  }
});
for (const id of p5aIds.slice(0, 3)) test(`P5A ${id}: NFFO 미공시는 not_reported이며 값/정의 생성 금지`, async () => {
  const result = await parseRealtyIncomeDocument(p5aDocument(id));
  assert.ok(!result.records.some(row => row.metric_code === 'NORMALIZED_FFO'));
  assert.ok(!result.definitions.some(row => row.metric_code === 'NORMALIZED_FFO'));
  assert.ok(result.availability.some(row => row.metric_code === 'NORMALIZED_FFO' && row.status === 'not_reported' && row.value === null));
});

for (const [name, action] of [
  ['VEREIT 소개', d => { d.excerpt.identity_text = 'VEREIT, Inc. (NYSE: VER)'; }],
  ['Spirit 소개', d => { d.excerpt.identity_text = 'Spirit Realty Capital (NYSE: SRC)'; }],
  ['다른 CIK', d => { d.source.cik = '0001507385'; }]
]) test(`P5A wrong issuer: ${name} → rejected`, async () => {
  const result = await changed('2022-q3', action);
  assert.equal(result.status, 'rejected'); assert.equal(result.errors[0].code, 'wrong_issuer'); assert.equal(result.records.length, 0);
});
test('P5A O 소개 안의 VEREIT 합병 설명은 wrong issuer로 오인하지 않음', async () => {
  assert.ok(p5aDocument('2022-q3').excerpt.definition_excerpts.some(row => row.text.includes('VEREIT')));
  assert.equal((await parseRealtyIncomeDocument(p5aDocument('2022-q3'))).status, 'parsed');
});

for (const [name, id, action] of [
  ['unknown format', '2017-q1', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('Funds From Operations (FFO)', 'Unrecognized Operations'); }],
  ['unit mismatch', '2022-q3', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('in thousands', 'in millions'); }],
  ['Q1 반복 연도 머리글', '2017-q1', d => { d.excerpt.pages[0].text += '\n2017 2016'; }],
  ['Q1 거짓 YTD 열', '2017-q1', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('2017 2016', '2017 2016 2017 2016'); }],
  ['Q3 기간 그룹 반전', '2020-q3', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('Three Months Ended September 30, Nine Months Ended September 30,', 'Nine Months Ended September 30, Three Months Ended September 30,'); }],
  ['주당 기준 중복', '2023-q3', d => { d.excerpt.pages[1].text += '\nAFFO per common share, basic and diluted $ 1.02 $ 0.98 $ 2.99 $ 2.92'; }],
  ['정의 누락', '2022-q3', d => { d.excerpt.definition_excerpts = []; }],
  ['source hash 미검증 URL', '2023-q3', d => { d.source.source_url = 'https://www.realtyincome.com/unverified.pdf'; }]
]) test(`P5A fail closed: ${name} → needs_review, 부분 값 없음`, async () => {
  const result = await changed(id, action);
  assert.equal(result.status, 'needs_review', JSON.stringify(result.errors)); assert.equal(result.records.length, 0);
});
test('P5A 원문/발췌 hash 변조는 rejected', async () => {
  const document = p5aDocument('2017-q1'); document.source.source_hash = 'a'.repeat(64);
  assert.equal((await parseRealtyIncomeDocument(document)).status, 'rejected');
});

test('P5A comparison: 실제 2022 원문/2023 비교열 canonical 24건 값 일치', async () => {
  const results = await p5aResults();
  const comparison = compareObservations(results[3].records, results[4].records);
  assert.equal(comparison.length, 24); assert.ok(comparison.every(row => row.status === 'matching_comparative' && row.delta === 0));
});
test('P5A restatement 탐지: 차이를 보고하되 original 값/정책은 불변 (합성 차이)', async () => {
  const results = await p5aResults(); const later = structuredClone(results[4].records);
  const changed = later.find(row => row.fiscal_year === 2022 && row.value_basis === 'total');
  changed.canonical_value += 1000;
  const difference = compareObservations(results[3].records, later).filter(row => row.status === 'restated/comparative difference');
  assert.equal(difference.length, 1); assert.equal(difference[0].delta, 1000);
  assert.equal(compareObservations(results[3].records, results[4].records).filter(row => row.delta !== 0).length, 0);
});
test('P5A comparator는 동일 입력 문서 내 canonical duplicate를 거절', async () => {
  const records = (await p5aResults())[3].records;
  assert.throws(() => compareObservations([...records, records[0]], records), /중복/);
});

test('P5A 0018: comparison 중복 24건 값 하나 / provenance 둘 / idempotent', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite); const before = protectedDigest(sqlite);
    const results = await p5aResults();
    for (const result of results) { await saveSpecializedMetrics(DB, result); await saveSpecializedMetrics(DB, result); }
    const records = await readSpecializedMetrics(DB, 'O');
    assert.equal(records.length, 148);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n, 172);
    const repeated = records.filter(row => row.sources.length === 2);
    assert.equal(repeated.length, 24); assert.ok(repeated.every(row => row.fiscal_year === 2022 && row.validation_status === 'validated'));
    assert.equal(protectedDigest(sqlite), before);
  } finally { sqlite.close(); }
});
test('P5A 동일 key 값 충돌은 store가 거절하며 원래 값/provenance를 보존', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite); const results = await p5aResults(); await saveSpecializedMetrics(DB, results[3]);
    const before = await readSpecializedMetrics(DB, 'O'); const next = structuredClone(results[4]);
    const row = next.records.find(row => row.fiscal_year === 2022 && row.value_basis === 'total');
    row.raw_value += 1; row.canonical_value += 1000;
    await assert.rejects(saveSpecializedMetrics(DB, next), /값 충돌/);
    assert.deepEqual(await readSpecializedMetrics(DB, 'O'), before);
  } finally { sqlite.close(); }
});
test('P5A P3/P4 숫자/정의/출처 snapshot 완전 보존 / protected digest 변화 0', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite); const digest = protectedDigest(sqlite);
    const original = [...await officialResults(), ...await historicalResults()];
    assert.equal(original.slice(0, 2).flatMap(r => r.records).length, 96);
    assert.equal(original.slice(0, 2).flatMap(r => r.records).filter(r => r.validation_status === 'validated').length, 36);
    for (const result of original) await saveSpecializedMetrics(DB, result);
    const before = await readSpecializedMetrics(DB, 'O'); const keys = new Set(before.map(metricRecordKey));
    assert.equal(before.length, 248);
    for (const result of await p5aResults()) await saveSpecializedMetrics(DB, result);
    const all = await readSpecializedMetrics(DB, 'O');
    assert.deepEqual(all.filter(row => keys.has(metricRecordKey(row))), before);
    assert.equal(all.length, 396); assert.equal(all.filter(row => row.validation_status === 'validated').length, 198);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 14);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n, 420);
    assert.equal(protectedDigest(sqlite), digest);
  } finally { sqlite.close(); }
});
