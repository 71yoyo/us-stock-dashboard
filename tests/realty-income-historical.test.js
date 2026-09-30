import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalIds, historicalDocument, historicalResults } from './helpers/realty-income-historical-fixtures.js';
import { loadOfficialDocument, officialResults } from './helpers/realty-income-fixtures.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';
import { detectDocumentFormat, FORMATS, excerptHash } from '../worker/src/reit/realty-income-document-formats.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { parseRealtyIncomeHtml } from '../worker/src/reit/realty-income-parser.js';
import { normalizeHistoricalMetrics } from '../worker/src/reit/realty-income-normalizer.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';

const sort = records => [...records].sort((a, b) => metricRecordKey(a).localeCompare(metricRecordKey(b)));
async function changedDocument(id, change) {
  const document = historicalDocument(id);
  change(document);
  document.source.excerpt_hash = await excerptHash(document.excerpt);
  return parseRealtyIncomeDocument(document);
}
const formats = [FORMATS.legacy, FORMATS.middle, FORMATS.joint, FORMATS.mixed];
const counts = [24, 32, 48, 48];
for (const [index, id] of historicalIds.entries()) {
  test(`P4 ${id}: 복수 fingerprint로 format 식별`, async () => {
    const result = await detectDocumentFormat(historicalDocument(id));
    assert.equal(result.status, 'detected');
    assert.equal(result.format, formats[index]);
  });
  test(`P4 ${id}: 수동 공식 expected 전부 일치 / 나머지 parsed 유지`, async () => {
    const result = (await historicalResults())[index];
    assert.equal(result.records.length, counts[index]);
    assert.equal(result.records.filter(row => row.validation_status === 'validated').length, counts[index] / 2);
    assert.equal(result.records.filter(row => row.validation_status === 'parsed').length, counts[index] / 2);
    assert.ok(result.records.every(row => row.validation_status !== 'validated' || row.validation?.method === 'official_expected_fixture'));
  });
  test(`P4 ${id}: standalone와 누적 기간을 실제 열에서 분리`, async () => {
    const result = await parseRealtyIncomeDocument(historicalDocument(id));
    assert.deepEqual([...new Set(result.records.map(row => row.period_scope))].sort(), id === 'fy2016' ? ['annual', 'quarterly'] : ['quarterly', 'ytd']);
    const q = result.records.filter(row => row.period_scope === 'quarterly');
    const cumulative = result.records.filter(row => row.period_scope !== 'quarterly');
    assert.ok(q.every(row => row.period_start.endsWith(id === 'fy2016' ? '-10-01' : '-04-01')));
    assert.ok(cumulative.every(row => row.period_start.endsWith('-01-01')));
    assert.ok(!result.records.some(row => row.period_scope === 'ttm'));
  });
}

test('P4 2016: FFO/AFFO total/basic/diluted-share만 보존, NFFO/diluted-total 생성 금지', async () => {
  const result = await parseRealtyIncomeDocument(historicalDocument('fy2016'));
  assert.equal(result.records.some(row => row.metric_code === 'NORMALIZED_FFO'), false);
  assert.equal(result.definitions.some(row => row.metric_code === 'NORMALIZED_FFO'), false);
  assert.equal(result.records.some(row => row.value_basis === 'total' && row.share_basis === 'diluted'), false);
  assert.equal(result.availability.length, 3);
  assert.ok(result.availability.every(row => row.status === 'not_reported' && row.value === null));
});

test('P4 2016: raw/canonical/단위를 표 근거에서 검증', async () => {
  const result = await parseRealtyIncomeDocument(historicalDocument('fy2016'));
  const ffo = result.records.find(row => row.metric_code === 'FFO' && row.fiscal_year === 2016 && row.period_scope === 'annual' && row.value_basis === 'total');
  assert.equal(ffo.raw_value, 735395); assert.equal(ffo.raw_unit, 'USD thousand');
  assert.equal(ffo.raw_unit_multiplier, 1000); assert.equal(ffo.canonical_value, 735395000);
  const share = result.records.find(row => row.metric_code === 'AFFO' && row.fiscal_year === 2016 && row.period_scope === 'annual' && row.share_basis === 'diluted');
  assert.equal(share.raw_value, 2.88); assert.equal(share.raw_unit_multiplier, 1); assert.equal(share.canonical_value, 2.88);
  assert.ok(ffo.sources[0].definition_evidence.ffo_table.includes('258,373,179'));
  assert.equal(ffo.sources[0].weighted_share_count_raw_unit, 'shares');
});

test('P4 2019: diluted total과 per-share를 구분하며 NFFO는 미공시', async () => {
  const result = await parseRealtyIncomeDocument(historicalDocument('q2-2019'));
  assert.equal(result.records.filter(row => row.value_basis === 'total' && row.share_basis === 'diluted').length, 8);
  assert.equal(result.records.some(row => row.metric_code === 'NORMALIZED_FFO'), false);
  assert.equal(result.availability[0].status, 'not_reported');
});

test('P4 2021: 본문 VEREIT 합병 설명은 O issuer 판정과 별개', async () => {
  const document = historicalDocument('q2-2021');
  assert.ok(document.excerpt.definition_excerpts.some(row => row.text.includes('VEREIT')));
  const result = await parseRealtyIncomeDocument(document);
  assert.equal(result.status, 'parsed');
  const shares = result.records.filter(row => row.value_basis === 'per_share');
  assert.ok(shares.every(row => row.sources[0].share_disclosure === 'basic_and_diluted_joint'));
});

test('P4 2024: 별도 FFO basic/diluted와 공동 NFFO/AFFO를 구분', async () => {
  const result = await parseRealtyIncomeDocument(historicalDocument('q2-2024'));
  assert.ok(result.records.every(row => row.sources[0].weighted_share_count_raw_unit === 'shares thousand'));
  for (const row of result.records.filter(row => row.value_basis === 'per_share')) {
    assert.equal(row.sources[0].share_disclosure, row.metric_code === 'FFO' ? 'separate' : 'basic_and_diluted_joint');
  }
  const previousYtd = result.records.filter(row => row.metric_code === 'FFO' && row.fiscal_year === 2023 && row.period_scope === 'ytd' && row.value_basis === 'per_share');
  assert.deepEqual(previousYtd.map(row => row.raw_value), [2.06, 2.05]);
});

for (const [name, change] of [
  ['corporate identity', d => { d.excerpt.identity_text = 'VEREIT, Inc. (NYSE: VER)\nOur common stock is traded on the New York Stock Exchange under the symbol "VER"'; }],
  ['CIK', d => { d.source.cik = '0001507385'; }],
  ['issuer', d => { d.source.issuer = 'VEREIT, Inc.'; }],
  ['ticker', d => { d.source.ticker = 'VER'; }]
]) test(`P4 wrong issuer: ${name} 불일치 즉시 rejected`, async () => {
  const result = await changedDocument('q2-2021', change);
  assert.equal(result.status, 'rejected'); assert.equal(result.errors[0].code, 'wrong_issuer');
  assert.equal(result.records.length, 0);
});

test('P4 ticker O만 같아도 다른 issuer는 허용하지 않음', async () => {
  const result = await changedDocument('q2-2021', d => { d.excerpt.identity_text = 'Other Realty (NYSE: O)'; });
  assert.equal(result.status, 'rejected');
});

for (const [name, id, change] of [
  ['숫자 열 누락', 'fy2016', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('$ 199,833 $ 177,908 $ 735,395 $ 652,437', '$ 199,833 $ 177,908 $ 735,395'); }],
  ['단위 모호', 'fy2016', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('dollars in thousands', 'dollars in millions'); }],
  ['기간 그룹 반전', 'q2-2019', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('Three months ended Six months ended', 'Six months ended Three months ended'); }],
  ['비교 연도 반전', 'q2-2019', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('2019 2018 2019 2018', '2018 2019 2018 2019'); }],
  ['FFO 반복값 불일치', 'q2-2021', d => { d.excerpt.pages[0].text = d.excerpt.pages[0].text.replace('FFO available to common stockholders $ 314,375', 'FFO available to common stockholders $ 314,374'); }],
  ['공동/별도 행 중복', 'q2-2024', d => { d.excerpt.pages[0].text += '\nFFO per common share, basic and diluted $ 1.07 $ 1.02 $ 2.01 $ 2.06'; }],
  ['NFFO 정의 없음', 'q2-2021', d => { d.excerpt.definition_excerpts = d.excerpt.definition_excerpts.filter(row => !row.text.includes('VEREIT')); }],
  ['미조사 출처', 'q2-2024', d => { d.source.source_url = 'https://www.realtyincome.com/unknown.pdf'; }],
  ['동일 표 페이지 중복', 'fy2016', d => { d.excerpt.pages.push(d.excerpt.pages[0]); }],
  ['회사 소개 없음', 'q2-2021', d => { delete d.excerpt.identity_text; }]
]) test(`P4 ambiguous: ${name} → needs_review / 부분 성공 저장 없음`, async () => {
  const result = await changedDocument(id, change);
  assert.equal(result.status, 'needs_review', JSON.stringify(result.errors)); assert.equal(result.records.length, 0);
});

test('P4 원문 hash 불일치 → rejected', async () => {
  const result = await changedDocument('fy2016', d => { d.source.source_hash = 'a'.repeat(64); });
  assert.equal(result.status, 'rejected'); assert.equal(result.errors[0].code, 'SOURCE_HASH_MISMATCH');
});
test('P4 발췌 hash 불일치 → rejected', async () => {
  const document = historicalDocument('fy2016'); document.excerpt.pages[0].text += '변경';
  const result = await parseRealtyIncomeDocument(document);
  assert.equal(result.status, 'rejected');
});
test('P4 image-only/unsupported PDF → needs_review, OCR 자동 성공 없음', async () => {
  const document = historicalDocument('fy2016'); document.excerpt.pages.forEach(page => { page.text = ''; });
  const result = await parseRealtyIncomeDocument(document);
  assert.equal(result.status, 'needs_review'); assert.equal(result.errors[0].code, 'IMAGE_ONLY_OR_UNSUPPORTED');
});
test('P4 입력 객체 오류 → needs_review', async () => {
  const result = await parseRealtyIncomeDocument(null);
  assert.equal(result.status, 'needs_review');
});

test('P4 레이아웃 변화만으로 FFO 정의 버전을 늘리지 않음 / NFFO 의미 변화 분리', async () => {
  const results = await historicalResults();
  assert.equal(results[1].definitions.find(row => row.metric_code === 'FFO').definition_version,
    results[3].definitions.find(row => row.metric_code === 'FFO').definition_version);
  assert.deepEqual(results[1].definitions.find(row => row.metric_code === 'FFO'), results[2].definitions.find(row => row.metric_code === 'FFO'));
  assert.notEqual(results[0].definitions.find(row => row.metric_code === 'FFO').definition_version,
    results[1].definitions.find(row => row.metric_code === 'FFO').definition_version);
  assert.notEqual(results[2].definitions.find(row => row.metric_code === 'NORMALIZED_FFO').definition_version,
    results[3].definitions.find(row => row.metric_code === 'NORMALIZED_FFO').definition_version);
});
test('P4 공통 normalizer는 알 수 없는 단위/추정 null을 거절', () => {
  assert.throws(() => normalizeHistoricalMetrics({ observations: [{ metric_code: 'FFO', unit: 'USD million', value_basis: 'total' }],
    definitions: [{ metric_code: 'FFO' }], source: {}, availability: [] }), /단위/);
});
for (const id of ['fy2025', 'q2-2026']) test(`P4 ${id}: 현대 adapter가 P3 결과 전체를 변경하지 않음`, async () => {
  const document = loadOfficialDocument(id);
  assert.equal((await detectDocumentFormat(document)).format, FORMATS.modern);
  assert.deepEqual(await parseRealtyIncomeDocument(document), await parseRealtyIncomeHtml(document));
});
test('P4 SEC URL의 다른 CIK → wrong_issuer', async () => {
  const document = loadOfficialDocument('fy2025'); document.source.source_url = document.source.source_url.replace('/726728/', '/1507385/');
  const result = await parseRealtyIncomeDocument(document);
  assert.equal(result.status, 'rejected'); assert.equal(result.errors[0].code, 'wrong_issuer');
});

test('P4 0018 DB round-trip/idempotent, P3와 financial/classification 변화 0', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite); const before = protectedDigest(sqlite);
    const modern = await officialResults();
    for (const result of modern) await saveSpecializedMetrics(DB, result);
    const old = await readSpecializedMetrics(DB, 'O');
    const historical = await historicalResults();
    for (const result of historical) { await saveSpecializedMetrics(DB, result); await saveSpecializedMetrics(DB, result); }
    const all = await readSpecializedMetrics(DB, 'O');
    assert.equal(all.length, 248); assert.deepEqual(sort(all), sort([...old, ...historical.flatMap(result => result.records)]));
    assert.deepEqual(sort(all.filter(row => row.definition_version.startsWith('EX99.1'))), sort(old));
    assert.equal(protectedDigest(sqlite), before);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 14);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n, 248);
    assert.ok(all.filter(row => row.fiscal_year === 2016).every(row => row.sources[0].availability.some(item => item.status === 'not_reported')));
  } finally { sqlite.close(); }
});
test('P4 실패/검토 결과는 기존 store가 자동 저장하지 않음', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    for (const status of ['needs_review', 'rejected']) await assert.rejects(saveSpecializedMetrics(DB, { status, records: [] }));
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_values').get().n, 0);
  } finally { sqlite.close(); }
});
