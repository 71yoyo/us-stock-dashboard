import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRealtyIncomeHtml } from '../worker/src/reit/realty-income-parser.js';
import { assertMetricRecord, metricRecordKey, validateAgainstOfficialExpected } from '../worker/src/specialized-metrics.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';
import { loadOfficialDocument, loadExpected, officialResults, fixtureHash } from './helpers/realty-income-fixtures.js';

const migration = readFileSync(new URL('../worker/migrations/0018_company_specialized_metrics.sql', import.meta.url), 'utf8');
const expected = loadExpected();
const results = await officialResults();
const records = results.flatMap(result => result.records);
const byKey = new Map(records.map(record => [metricRecordKey(record), record]));
const sortRecords = rows => [...rows].sort((a, b) => metricRecordKey(a).localeCompare(metricRecordKey(b)));

for (const id of ['fy2025', 'q2-2026']) {
  test(`O ${id} 공식 HTML 발췌: 48 records는 처음에는 parsed다`, async () => {
    const document = loadOfficialDocument(id);
    assert.equal(fixtureHash(document.html), document.source.excerpt_hash);
    const parsed = await parseRealtyIncomeHtml(document);
    assert.equal(parsed.status, 'parsed');
    assert.equal(parsed.records.length, 48);
    assert.equal(parsed.definitions.length, 3);
    assert.ok(parsed.records.every(record => record.validation_status === 'parsed' && record.validation === null));
  });
}

// 숫자 기대값은 테스트 fixture에서만 읽으며 각 basis·scope를 독립적으로 exact 비교한다.
for (const row of expected.fixture.records) {
  test(`공식 exact: ${row.period_label} ${row.metric_code} ${row.value_basis}/${row.share_basis}`, () => {
    const actual = byKey.get(metricRecordKey(row));
    for (const [key, value] of Object.entries(row)) assert.equal(actual[key], value, key);
    assert.equal(actual.validation_status, 'validated');
    assert.equal(actual.validation.fixture_hash, expected.hash);
  });
}

test('동일 지표 common total / diluted total / basic share / diluted share는 네 개의 독립 키다', () => {
  const ffo = records.filter(record => record.period_scope === 'annual' && record.fiscal_year === 2025 && record.metric_code === 'FFO');
  assert.equal(ffo.length, 4);
  assert.equal(new Set(ffo.map(metricRecordKey)).size, 4);
  assert.notEqual(ffo.find(row => row.share_basis === 'not_applicable').raw_value,
    ffo.find(row => row.value_basis === 'total' && row.share_basis === 'diluted').raw_value);
});

test('Q2 standalone와 YTD는 end가 같아도 시작일·scope·label·키가 다르다', () => {
  const rows = records.filter(row => row.fiscal_year === 2026 && row.metric_code === 'AFFO' && row.share_basis === 'not_applicable');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.period_start).sort(), ['2026-01-01', '2026-04-01']);
  assert.equal(new Set(rows.map(row => row.period_end)).size, 1);
  assert.equal(new Set(rows.map(metricRecordKey)).size, 2);
  assert.equal(rows.find(row => row.period_scope === 'quarterly').raw_value, expected.fixture.records
    .find(row => row.period_scope === 'quarterly' && row.metric_code === 'AFFO' && row.share_basis === 'not_applicable').raw_value);
});

test('총액 USD thousand ×1000 / 주당 USD/share ×1은 별도로 보존한다', () => {
  for (const row of records) {
    assert.equal(row.canonical_value, row.raw_value * row.raw_unit_multiplier);
    assert.equal(row.raw_unit_multiplier, row.value_basis === 'total' ? 1000 : 1);
    assert.equal(row.canonical_unit, row.value_basis === 'total' ? 'USD' : 'USD/share');
  }
});

test('출처 URL·accession·EX99.1·표 제목·원문 hash·발췌 hash·회계기간 근거가 보존된다', () => {
  for (const record of records) {
    const source = record.sources[0];
    assert.equal(source.source_type, 'SEC_EXHIBIT');
    assert.equal(source.exhibit, 'EX-99.1');
    assert.match(source.accession_number, /^0000726728-26-0000(?:09|44)$/);
    assert.match(source.source_hash, /^[a-f0-9]{64}$/);
    assert.equal(source.input_hash, source.excerpt_hash);
    assert.ok(source.table_title && source.section && source.document_name && source.retrieved_at && source.fiscal_year_end_source);
    assert.equal(source.page_number, null); // HTML 페이지 번호를 PDF 페이지 번호로 가장하지 않는다.
  }
});

test('2025/2026 정의 버전은 분리하고 AFFO 회사 고유 정의·출처를 유지한다', () => {
  assert.notEqual(results[0].definitions[0].definition_version, results[1].definitions[0].definition_version);
  for (const result of results) {
    assert.deepEqual(result.definitions.map(row => row.metric_code), ['FFO', 'NORMALIZED_FFO', 'AFFO']);
    assert.ok(result.definitions.every(row => row.definition_owner === 'CIK0000726728' && row.definition_source.includes('sec.gov')));
    assert.match(result.definitions.find(row => row.metric_code === 'AFFO').definition_notes, /고유|연도별/);
  }
});

test('expected에서 검증한 36건만 validated이며 비교연도/Q4 60건은 parsed다', () => {
  assert.equal(records.filter(row => row.validation_status === 'validated').length, 36);
  assert.equal(records.filter(row => row.validation_status === 'parsed').length, 60);
});

test('expected 숫자·기간·단위·basis 불일치는 검증 승격되지 않는다', () => {
  for (const change of [{ raw_value: -1 }, { period_start: '2025-02-01' }, { canonical_unit: 'EUR' }, { share_basis: 'basic' }]) {
    const fixture = { records: [{ ...expected.fixture.records[0], ...change }] };
    assert.throws(() => validateAgainstOfficialExpected(records, fixture, expected.hash), /expected/);
  }
});

function duplicateRow(html, text) {
  const row = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find(match => match[0].includes(text))?.[0];
  assert.ok(row, '변형할 fixture 행 없음');
  return html.replace(row, row + row);
}

const failures = [
  ['metric label 없음', html => html.replaceAll('AFFO available to common stockholders', 'Missing metric'), 'MISSING_LABEL'],
  ['공통 총액 중복', html => duplicateRow(html, 'AFFO available to common stockholders'), 'DUPLICATE_LABEL'],
  ['FFO 반복 행 추가', html => duplicateRow(html, 'FFO available to common stockholders'), 'DUPLICATE_LABEL'],
  ['colspan 모호', html => html.replace('colspan="9"', 'colspan="8"'), 'COLUMN_AMBIGUITY'],
  ['standalone/YTD 기간 모호', html => html.replace('Six months ended', 'Nine months ended'), 'PERIOD_AMBIGUITY'],
  ['단위 없음', html => html.replaceAll('(in thousands, except per share amounts)', '(unit not disclosed)'), 'UNIT_UNKNOWN'],
  ['Basic 기준 없음', html => html.replaceAll('>Basic<', '>Unknown<'), 'BASIS_AMBIGUITY'],
  ['주당 Diluted 행 중복', html => duplicateRow(html, '>Diluted<'), 'BASIS_AMBIGUITY'],
  ['숫자 없음', html => html.replace('1,022,120', 'Loading...'), 'VALUE_AMBIGUITY'],
  ['알 수 없는 rowspan', html => html.replace('<td', '<td rowspan="2"'), 'COLUMN_AMBIGUITY'],
  ['연도 머리글 부족', html => html.replace('>2026<', '>year unknown<'), 'COLUMN_AMBIGUITY'],
  ['공식 연도와 불일치', html => html.replaceAll('>2026<', '>2027<'), 'PERIOD_AMBIGUITY']
];
for (const [name, modify, code] of failures) {
  test(`fail-closed: ${name}이면 needs_review, records 없음, DB 저장 금지`, async () => {
    const document = loadOfficialDocument('q2-2026');
    const html = modify(document.html);
    const result = await parseRealtyIncomeHtml({ html, source: { ...document.source, excerpt_hash: fixtureHash(html) } });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.errors[0].code, code, JSON.stringify(result.errors));
    assert.equal(result.records.length, 0);
    await assert.rejects(saveSpecializedMetrics({}, result), /저장/);
  });
}

test('원문/발췌 hash가 다르면 값을 읽기 전에 중단한다', async () => {
  const document = loadOfficialDocument('fy2025');
  const result = await parseRealtyIncomeHtml({ ...document, html: document.html + '<p>tampered</p>' });
  assert.equal(result.errors[0].code, 'SOURCE_HASH_MISMATCH');
  assert.equal(result.records.length, 0);
});

test('미지원 accession·URL·공식 Q label·연말 근거는 추측하지 않는다', async () => {
  const document = loadOfficialDocument('q2-2026');
  for (const change of [{ accession_number: 'legacy-2016' }, { source_url: 'https://example.invalid/report' },
    { fiscal_period: 'Q3' }, { fiscal_year_end_source: '' }]) {
    const result = await parseRealtyIncomeHtml({ ...document, source: { ...document.source, ...change } });
    assert.equal(result.errors[0].code, 'SOURCE_UNSUPPORTED');
    assert.equal(result.records.length, 0);
  }
});

test('Migration 0018은 새 테이블/인덱스만 추가하며 기존 migration·GAAP 테이블을 수정하지 않는다', () => {
  assert.doesNotMatch(migration, /\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i);
  assert.doesNotMatch(migration, /financial_metrics|company_classification/);
  assert.equal((migration.match(/CREATE TABLE/g) || []).length, 3);
});

test('Fresh 0001~0018 메모리 DB에서 전체 저장·정의·출처 round-trip', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    for (const result of results) await saveSpecializedMetrics(DB, result);
    assert.deepEqual(sortRecords(await readSpecializedMetrics(DB, 'O')), sortRecords(records));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_metric_definitions').get().n, 6);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_metric_sources').get().n, 96);
    const definitions = sqlite.prepare('SELECT * FROM company_metric_definitions').all();
    for (const definition of results.flatMap(result => result.definitions)) {
      assert.deepEqual({ ...definitions.find(row => row.metric_code === definition.metric_code && row.definition_version === definition.definition_version) }, definition);
    }
  } finally { sqlite.close(); }
});

test('Existing 0017 → 0018 전후 financial/classification 전체 행 digest 동일', async () => {
  const { sqlite, DB } = createMetricTestDatabase(false);
  try {
    seedProtectedMetrics(sqlite);
    const before = protectedDigest(sqlite);
    sqlite.exec(migration);
    assert.equal(protectedDigest(sqlite), before);
    for (const result of results) await saveSpecializedMetrics(DB, result);
    assert.equal(protectedDigest(sqlite), before);
    assert.equal((await readSpecializedMetrics(DB, 'O')).length, 96);
  } finally { sqlite.close(); }
});

test('재실행 idempotency 및 parsed 재저장 시 validated 상태 보존', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    await saveSpecializedMetrics(DB, results[0]);
    await saveSpecializedMetrics(DB, results[0]);
    await saveSpecializedMetrics(DB, await parseRealtyIncomeHtml(loadOfficialDocument('fy2025')));
    const rows = await readSpecializedMetrics(DB, 'O');
    assert.equal(rows.length, 48);
    assert.equal(rows.filter(row => row.validation_status === 'validated').length, 12);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_metric_sources').get().n, 48);
  } finally { sqlite.close(); }
});

test('동일 값의 SEC + synthetic IR 복수 출처는 값 복제 없이 round-trip', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    const result = structuredClone(results[0]);
    // 저장구조만 검증하는 합성 IR 출처다. 실제 IR 문서를 대조/검증했다는 주장이 아니다.
    const source = { ...result.records[0].sources[0], source_type: 'SYNTHETIC_IR_TEST',
      source_url: 'https://example.invalid/synthetic-ir-report', source_hash: fixtureHash('synthetic IR fixture'),
      document_name: 'synthetic-ir-test.html' };
    result.records[0].sources.push(source);
    await saveSpecializedMetrics(DB, result);
    const row = (await readSpecializedMetrics(DB, 'O')).find(row => metricRecordKey(row) === metricRecordKey(result.records[0]));
    assert.equal(row.sources.length, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_metric_values').get().n, 48);
    assert.deepEqual(row.sources.find(item => item.source_type === 'SYNTHETIC_IR_TEST'), source);
  } finally { sqlite.close(); }
});

test('동일 버전 정의/값 충돌은 정상값을 덮어쓰지 않는다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    await saveSpecializedMetrics(DB, results[0]);
    const bad = structuredClone(results[0]);
    bad.records[0].raw_value += 1;
    bad.records[0].canonical_value = bad.records[0].raw_value * bad.records[0].raw_unit_multiplier;
    await assert.rejects(saveSpecializedMetrics(DB, bad), /충돌/);
    const definitionChange = structuredClone(results[0]);
    definitionChange.definitions[0].definition_notes = '동일 버전 변경';
    await assert.rejects(saveSpecializedMetrics(DB, definitionChange), /정의 변경/);
    assert.deepEqual(sortRecords(await readSpecializedMetrics(DB, 'O')), sortRecords(results[0].records));
  } finally { sqlite.close(); }
});

test('검증 근거 없는 validated·NULL·비정상 multiplier·주당 기준 누락 저장 금지', () => {
  for (const change of [{ validation: null }, { raw_value: null }, { raw_unit_multiplier: 0 },
    { canonical_value: Infinity }, { value_basis: 'per_share', share_basis: 'not_applicable' },
    { period_start: '2026-02-30' }, { sources: [] }]) {
    assert.throws(() => assertMetricRecord({ ...records.find(row => row.validation_status === 'validated'), ...change }));
  }
});

test('누락된 회사 FK로 batch 실패 시 정의/값/출처 모두 rollback', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    await assert.rejects(saveSpecializedMetrics(DB, results[0]), /FOREIGN KEY/);
    for (const table of ['company_metric_definitions', 'company_metric_values', 'company_metric_sources']) {
      assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { sqlite.close(); }
});

test('BANK/EXCHANGE 확장 및 TTM/percentage/count를 schema 변경 없이 저장 가능: 합성 값만 사용', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    for (const [profile, code, basis, unit] of [['BANK', 'SYNTHETIC_NIM', 'percentage', '%'], ['EXCHANGE', 'SYNTHETIC_ADV', 'count', 'contracts']]) {
      const definition = { ...results[0].definitions[0], metric_code: code, profile, default_unit: unit, definition_owner: 'SYNTHETIC', definition_version: 'test-only' };
      const record = { ...structuredClone(records[0]), ticker: 'TEST', metric_code: code, definition_owner: 'SYNTHETIC', definition_version: 'test-only',
        period_scope: 'ttm', period_start: '2025-07-01', period_end: '2026-06-30', period_label: 'TTM synthetic',
        value_basis: basis, share_basis: 'not_applicable', attribution_basis: 'company', raw_value: 2,
        raw_unit: unit, raw_unit_multiplier: 1, canonical_value: 2, canonical_unit: unit, validation_status: 'parsed', validation: null };
      await saveSpecializedMetrics(DB, { status: 'parsed', definitions: [definition], records: [record] });
    }
    assert.equal((await readSpecializedMetrics(DB, 'TEST')).length, 2);
  } finally { sqlite.close(); }
});
