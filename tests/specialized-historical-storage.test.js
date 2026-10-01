import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { p5cb2Results } from './helpers/realty-income-p5cb2-fixtures.js';
import { createHistoricalDatabase, specializedSnapshot, hash, stableData } from '../scripts/specialized-disposable-db.mjs';
import { backfillHistorical, assertParserDbAgreement } from '../scripts/specialized-historical-backfill.mjs';
import { runHistoricalStorageAudit } from '../scripts/realty-income-p6-core.mjs';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { querySpecializedMetrics, specializedDefinitionBoundaries, validateSpecializedQuery } from '../worker/src/specialized-metric-query.js';

// 네트워크 없는 최소 fixture로 CI를 재현한다. 실제 40 cache 검증은 별도 audit 명령으로 수행한다.
const rows = p5cb2Results();
const audit = rows.then(runHistoricalStorageAudit);
const queryDatabase = rows.then(async documents => {
  const database = await createHistoricalDatabase();
  try { await backfillHistorical(database, documents); return database; }
  catch (error) { database.sqlite.close(); throw error; }
});
after(async () => { (await queryDatabase).sqlite.close(); await audit; });
const base = { ticker: 'O', metricCode: 'AFFO', periodScope: 'quarterly', valueBasis: 'per_share', shareBasis: 'diluted' };
const query = async overrides => querySpecializedMetrics((await queryDatabase).DB, { ...base, ...overrides });

test('P6 독립 메모리 SQLite에 0001~0018 fresh migration, metadata 규칙으로 REIT 준비', async () => {
  const result = await audit;
  assert.equal(result.db.migrations.length, 18); assert.ok(result.db.migrations[0].startsWith('0001_'));
  assert.ok(result.db.migrations.at(-1).startsWith('0018_')); assert.equal(result.db.pathA, ':memory:');
  assert.equal(result.db.pathB, ':memory:'); assert.equal(result.db.persistentFiles, 0);
  assert.equal(result.db.profile.autoType, 'REIT'); assert.equal(result.db.profile.confidence, 'high');
  assert.equal(result.db.isolated, true); assert.equal(result.databaseClosedAfterAudit, true);
});
test('P6 최초 40문서 적재와 동적 parser/DB 전체 의미 비교', async () => {
  const result = await audit;
  assert.equal(result.run1.processed, 40); assert.equal(result.run1.accepted, 40);
  assert.deepEqual(result.run1.counts, { definitions: 14, values: 950, provenance: 1344 });
  assert.equal(result.parserAgreement.semanticRoundTrip, true);
  assert.equal(result.parserAgreement.observations, 1344);
});
for (const kind of ['definitions', 'values', 'provenance'])
  test(`P6 동일 backfill ${kind} count/digest idempotency`, async () => {
    const result = await audit; assert.equal(result.run1.counts[kind], result.run2.counts[kind]);
    assert.equal(result.run1.digests[kind], result.run2.digests[kind]); assert.equal(result.run1.digest, result.run2.digest);
  });
for (const kind of ['value', 'provenance', 'definition'])
  test(`P6 logical ${kind} duplicate 0`, async () => assert.equal((await audit).duplicates[kind], 0));
test('P6 validated 162 / parsed 788 유지, 저장에 의한 자동 승격 없음', async () => {
  assert.deepEqual((await audit).parserAgreement.validationStatuses, { parsed: 788, validated: 162 });
});
test('P6 같은 key 다른 숫자는 conflict, 기존 값/전체 DB 보존', async () => {
  const result = await audit; assert.equal(result.failures.conflictRejected, true); assert.equal(result.failures.existingValueUnchanged, true);
});
test('P6 동일 version 정의 변조 거부', async () => assert.equal((await audit).failures.definitionConflictRejected, true));
test('P6 provenance 중간 실제 SQL 실패는 문서 전체 rollback, 선행 정상 문서 보존', async () => {
  const rollback = (await audit).failures.rollback;
  assert.equal(rollback.actualSqlTrigger, true); assert.equal(rollback.documentAtomic, true);
  assert.equal(rollback.afterEarlierSourceInsert, true);
  assert.ok(rollback.batchStatements > 10); assert.equal(rollback.previousDocumentsPreserved, true);
  assert.equal(rollback.successfulRetryAfterRemovingTrigger, true);
});
test('P6 FY2025 승인된 SEC/IR view만 12값/24출처, 재실행 출처 추가 없음', async () => {
  const result = (await audit).additionalProvenance;
  assert.equal(result.exact, 12); assert.equal(result.after.values, 12); assert.equal(result.after.provenance, 24);
  assert.equal(result.before.provenance, 12); assert.equal(result.repeatedSame, true);
  assert.equal(result.automaticDefinitionMerge, false); assert.equal(result.reviewedEquivalenceOnly, true);
});
test('P6 DB A/B fresh rebuild count와 3종 digest 모두 동일', async () => {
  const result = await audit; assert.deepEqual(result.run1.counts, result.rebuild.counts);
  assert.deepEqual(result.run1.digests, result.rebuild.digests); assert.equal(result.rebuild.digest, result.run1.digest);
});
test('P6 financial_metrics / company_classification digest 보존', async () => assert.equal((await audit).protectedUnchanged, true));
test('P6 parser output 전량 hash / 40 coverage / 1344 관측 / 950 값 / conflict 0 유지', async () => {
  const result = await audit; assert.equal(result.parserUnchanged, true);
  assert.deepEqual(result.input.summary.statuses, { VERIFIED_PARSED: 9, PARSED: 31, NEEDS_REVIEW: 0,
    UNKNOWN_FORMAT: 0, WRONG_ISSUER: 0, SOURCE_UNAVAILABLE: 0, PARSER_ERROR: 0 });
  assert.equal(result.input.summary.dedup.observations, 1344); assert.equal(result.input.summary.dedup.unique_values, 950);
  assert.equal(result.input.summary.comparison.exact_match, 394); assert.equal(result.input.summary.comparison.difference, 0);
  assert.deepEqual(result.input.summary.dedup.conflicts, []);
});
for (const [scope, metric, expected] of [['quarterly', 'FFO', 40], ['quarterly', 'AFFO', 40], ['quarterly', 'NORMALIZED_FFO', 19],
  ['annual', 'FFO', 10], ['annual', 'AFFO', 10], ['annual', 'NORMALIZED_FFO', 5],
  ['ytd', 'FFO', 20], ['ytd', 'AFFO', 20], ['ytd', 'NORMALIZED_FFO', 10]])
  test(`P6 ${metric} ${scope} 직접 공시기간 ${expected}개, 오래된→최신`, async () => {
    const result = await query({ periodScope: scope, metricCode: metric }); assert.equal(result.data.length, expected);
    assert.ok(result.data.every((row, index) => !index || result.data[index - 1].periodEnd <= row.periodEnd));
    assert.equal(result.sourcePolicy, 'primary_period_disclosure'); assert.equal(result.economicContinuityAssumed, false);
  });
test('P6 2016~2020 미공시 NFFO는 빈 배열, 0 보간 없음', async () => {
  for (const scope of ['quarterly', 'annual', 'ytd']) {
    assert.deepEqual((await query({ metricCode: 'NORMALIZED_FFO', periodScope: scope, end: '2020-12-31' })).data, []);
  }
});
test('P6 Q4 3M와 FY annual은 별도 scope, YTD는 Q2/Q3 6M/9M만', async () => {
  const quarterly = await query({ start: '2025-12-31', end: '2025-12-31' });
  const annual = await query({ periodScope: 'annual', start: '2025-12-31', end: '2025-12-31' });
  assert.equal(quarterly.data.length, 1); assert.equal(annual.data.length, 1);
  assert.equal(quarterly.data[0].periodStart, '2025-10-01'); assert.equal(annual.data[0].periodStart, '2025-01-01');
  assert.equal(quarterly.data[0].fiscalPeriod, 'Q4'); assert.equal(annual.data[0].fiscalPeriod, 'FY');
  const ytd = await query({ periodScope: 'ytd', start: '2025-01-01', end: '2025-12-31' });
  assert.deepEqual(ytd.data.map(row => [row.fiscalPeriod, row.periodStart, row.periodEnd]),
    [['Q2', '2025-01-01', '2025-06-30'], ['Q3', '2025-01-01', '2025-09-30']]);
});
for (const [basis, share, unit, expected] of [['total', 'not_applicable', 'USD', 40], ['total', 'diluted', 'USD', 33],
  ['per_share', 'basic', 'USD/share', 40], ['per_share', 'diluted', 'USD/share', 40]])
  test(`P6 ${basis}/${share} 정확한 필터 및 canonical unit ${unit}`, async () => {
    const result = await query({ valueBasis: basis, shareBasis: share, unit }); assert.equal(result.data.length, expected);
    assert.ok(result.data.every(row => row.unit === unit && row.value === row.rawValue * row.rawMultiplier));
    assert.deepEqual((await query({ valueBasis: basis, shareBasis: share, unit: unit === 'USD' ? 'USD/share' : 'USD' })).data, []);
  });
test('P6 date는 periodEnd 포함 범위, NULL/역전/가짜 날짜 거부', async () => {
  const result = await query({ start: '2025-06-30', end: '2025-09-30' });
  assert.deepEqual(result.data.map(row => row.periodEnd), ['2025-06-30', '2025-09-30']);
  assert.equal(result.dateFilter, 'periodEnd inclusive');
  for (const invalid of [{ start: '2025-02-30' }, { end: null }, { start: '2026-01-01', end: '2025-01-01' }]) {
    await assert.rejects(() => query(invalid));
  }
});
for (const invalid of [{ ticker: "O' OR 1=1--" }, { metricCode: 'AFFO;' }, { periodScope: 'all' }, { valueBasis: 'unadjusted' },
  { shareBasis: 'both' }, { valueBasis: 'per_share', shareBasis: 'not_applicable' }, { includeComparisons: 'true' }, { growthYears: 5 }])
  test(`P6 잘못된 입력 ${Object.keys(invalid).join(',')} 거부`, async () => assert.throws(() => validateSpecializedQuery({ ...base, ...invalid })));
test('P6 optional 문자열 필터도 bind이며 SQL injection은 값으로만 처리', async () => {
  assert.deepEqual((await query({ definitionVersion: "x' OR 1=1--" })).data, []);
  assert.equal((await query({})).data.length, 40);
});
test('P6 없는 회사/지표는 빈 결과, 다른 회사 데이터 노출 없음', async () => {
  assert.deepEqual((await query({ ticker: 'JPM' })).data, []); assert.deepEqual((await query({ metricCode: 'NOT_REPORTED' })).data, []);
});
test('P6 comparison 원본도 조회 가능하며 다른 version은 숨기거나 병합하지 않음', async () => {
  const primary = await query({}), all = await query({ includeComparisons: true });
  assert.ok(all.data.length > primary.data.length); assert.equal(all.sourcePolicy, 'all_disclosures');
  assert.ok(all.data.some(row => row.fiscalYear === 2015));
  const groups = new Map();
  for (const row of all.data) { const key = row.periodEnd; if (!groups.has(key)) groups.set(key, new Set()); groups.get(key).add(row.definitionVersion); }
  assert.ok([...groups.values()].some(versions => versions.size > 1));
});
test('P6 definitionOwner/version/attribution 필터 및 원본 definition 보존', async () => {
  const original = await query({}), latest = original.data.at(-1);
  const selected = await query({ definitionOwner: latest.definitionOwner, definitionVersion: latest.definitionVersion,
    attributionBasis: latest.attributionBasis });
  assert.ok(selected.data.length > 0); assert.ok(selected.data.every(row => row.definitionVersion === latest.definitionVersion));
  assert.equal((await query({})).data.length, original.data.length);
});
test('P6 실제 AFFO/NFFO definition boundary와 attribution 변경을 구별', async () => {
  const affo = await query({}), nffo = await query({ metricCode: 'NORMALIZED_FFO' });
  assert.deepEqual(affo.definitionBoundaries.filter(row => row.kind === 'definition').map(row => `${row.fiscalYear}${row.fiscalPeriod}`),
    ['2017Q3', '2021Q2', '2021Q4', '2023Q4', '2024Q1', '2024Q3', '2024Q4']);
  assert.deepEqual(nffo.definitionBoundaries.map(row => `${row.fiscalYear}${row.fiscalPeriod}`),
    ['2021Q4', '2023Q4', '2024Q1', '2024Q3', '2024Q4']);
  assert.equal(affo.definitionBoundaries.find(row => row.fiscalYear === 2017 && row.fiscalPeriod === 'Q4').kind, 'attribution');
});
test('P6 같은 기간 복수 정의는 ambiguity 표시, 임의 최신 선택 없음', () => {
  const a = { fiscalYear: 2024, fiscalPeriod: 'Q1', periodStart: '2024-01-01', periodEnd: '2024-03-31',
    definitionOwner: 'TEST', definitionVersion: 'A', attributionBasis: 'common' };
  const b = { ...a, fiscalPeriod: 'Q2', periodStart: '2024-04-01', periodEnd: '2024-06-30' };
  const boundaries = specializedDefinitionBoundaries([a, b, { ...b, definitionVersion: 'B' }]);
  assert.equal(boundaries.length, 1); assert.equal(boundaries[0].ambiguousPeriod, true); assert.equal(boundaries[0].definitions.length, 2);
  const firstAmbiguous = specializedDefinitionBoundaries([a, { ...a, definitionVersion: 'B' }]);
  assert.equal(firstAmbiguous[0].ambiguousPeriod, true); assert.deepEqual(firstAmbiguous[0].previousDefinitions, []);
});
test('P6 query provenance는 raw unit/physical/printed/hash/document 보존', async () => {
  const result = await query({ start: '2025-12-31', end: '2025-12-31' }), row = result.data[0];
  assert.equal(row.unit, 'USD/share'); assert.equal(row.rawUnit, 'USD/share');
  const source = row.provenance.find(source => source.sourceFiscalYear === 2025);
  assert.equal(source.physicalPage, 35); assert.equal(source.printedPage, 17); assert.match(source.hash, /^[a-f0-9]{64}$/);
  assert.ok(source.document && source.section && source.rawUnitMeasurement && source.unitQualifier === 'unaudited');
});
test('P6 0과 음수도 저장값 그대로 조회, 예시 숫자는 별도 synthetic 메모리 DB만', async () => {
  for (const value of [0, -1.25]) {
    const database = await createHistoricalDatabase();
    try {
      const document = (await rows)[0], record = structuredClone(document.records.find(row => row.metric_code === 'AFFO' && row.value_basis === 'per_share'));
      record.raw_value = value; record.canonical_value = value; record.validation_status = 'parsed'; record.validation = null;
      const definition = document.definitions.find(row => row.metric_code === 'AFFO');
      await saveSpecializedMetrics(database.DB, { status: 'parsed', definitions: [definition], records: [record] });
      const result = await querySpecializedMetrics(database.DB, { ...base, shareBasis: record.share_basis });
      assert.equal(result.data.length, 1); assert.equal(result.data[0].value, value);
    } finally { database.sqlite.close(); }
  }
});
test('P6 기대값은 parser에서 동적 계산, 변조된 DB semantic digest는 거부', async () => {
  const database = await createHistoricalDatabase();
  try {
    const document = (await rows)[0]; await backfillHistorical(database, [document]);
    const before = assertParserDbAgreement(database.sqlite, [document]); assert.ok(before.uniqueValues > 0);
    database.sqlite.exec("UPDATE company_metric_values SET canonical_value=canonical_value+1 WHERE record_key=(SELECT MIN(record_key) FROM company_metric_values)");
    assert.throws(() => assertParserDbAgreement(database.sqlite, [document]), /parser와 저장 DB/);
  } finally { database.sqlite.close(); }
});
test('P6 유효 JSON이어도 null 출처 metadata는 정상 데이터처럼 반환하지 않음', async () => {
  const database = await createHistoricalDatabase();
  try {
    await backfillHistorical(database, [(await rows)[0]]);
    database.sqlite.exec("UPDATE company_metric_sources SET source_metadata_json='null'");
    await assert.rejects(() => querySpecializedMetrics(database.DB, { ...base, includeComparisons: true }), /metadata가 객체가 아닙니다/);
  } finally { database.sqlite.close(); }
});
test('P6 digest는 volatile 시각만 제외, provenance hash/page/section/definition/validation 변경은 감지', () => {
  const source = { retrieved_at: 'A', source_hash: 'original', page_number: 1, section: 'A', definition_version: 'V1', validation_status: 'parsed' };
  const digest = hash(stableData(source)); assert.equal(hash(stableData({ ...source, retrieved_at: 'B' })), digest);
  for (const key of ['source_hash', 'page_number', 'section', 'definition_version', 'validation_status']) {
    assert.notEqual(hash(stableData({ ...source, [key]: 'different' })), digest);
  }
});
test('P6 backfill은 arbitrary DB/D1를 받지 않고 검토/실패 문서도 거부', async () => {
  await assert.rejects(() => backfillHistorical({ path: 'existing.db' }, []), /메모리 SQLite/);
  const database = await createHistoricalDatabase();
  try {
    const rejected = { ...(await rows)[0], final_status: 'NEEDS_REVIEW' };
    await assert.rejects(() => backfillHistorical(database, [rejected]), /승인되지 않은 문서/);
    assert.equal(specializedSnapshot(database.sqlite).counts.values, 0);
  } finally { database.sqlite.close(); }
});
test('P6 운영 route/UI/scheduler에 연결하지 않으며 query에 growth 계산 없음', () => {
  const index = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  assert.ok(!index.includes('specialized-metric-query')); assert.ok(!index.includes('specialized-historical-backfill'));
  const code = readFileSync(new URL('../worker/src/specialized-metric-query.js', import.meta.url), 'utf8');
  assert.ok(!/Math\.pow|CAGR|fetch\(/.test(code));
});
